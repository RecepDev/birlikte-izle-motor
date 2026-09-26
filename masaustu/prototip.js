#!/usr/bin/env node
// Faz 0 prototipi: arayüzsüz masaüstü istemci.
// Odaya bağlanır, videoyu mpv'de açar, senkronu tutar, bekleme/kilit/altyazıya uyar.
// Amacı tek soruyu cevaplamak: senkron native oynatıcıda tarayıcıdaki kadar sıkı tutuyor mu?
//
// Kullanım: node masaustu/prototip.js <oda-linki> <isim> [--mpv <yol>]

import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';
import { createMpv } from './mpv.js';
import { syncAction, statusState, canControl } from './karar.js';
import { estimateClockOffset, expectedPosition } from '../public/js/shared/sync-core.js';
import { localTorrentUrl, torrentPath, STREMIO_BASE } from '../public/js/shared/stream-url.js';

const TICK_MS = 250;
const STATUS_MS = 2000;
const CLOCK_SAMPLES = 5;
// mpv'nin kendi duraklat/sar hareketimizi kullanıcı hareketi sanmamak için kısa bir pencere.
const PROGRAMMATIC_MS = 1000;

const log = (...parts) => console.log(new Date().toLocaleTimeString('tr-TR'), ...parts);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  const [link, name] = positional;
  if (!link || !name) {
    console.error('Kullanım: node masaustu/prototip.js <oda-linki> <isim> [--mpv <yol>]');
    process.exit(1);
  }
  let base = flags.sunucu || 'http://127.0.0.1:7000';
  let roomId = link;
  if (/^https?:\/\//i.test(link)) {
    const url = new URL(link);
    base = url.origin;
    roomId = url.pathname.split('/')[2] || '';
  }
  return {
    base,
    roomId: decodeURIComponent(roomId).toUpperCase(),
    name,
    mpvPath: flags.mpv || 'mpv',
    mpvArgs: flags['mpv-args'] ? flags['mpv-args'].split(' ').filter(Boolean) : [],
    debug: 'debug' in flags,
  };
}

const { base, roomId, name, mpvPath, mpvArgs, debug } = parseArgs(process.argv.slice(2));

// ---- sunucuyla konuşma --------------------------------------------------------------

const socket = io(base, { transports: ['websocket'] });
const request = (event, payload = {}) => new Promise((resolve) => socket.emit(event, payload, resolve));

let room = null; // son anlık görüntü (snapshot) + gelen olaylarla güncellenir
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;

async function calibrateClock() {
  const samples = [];
  for (let i = 0; i < CLOCK_SAMPLES; i++) {
    const sent = Date.now();
    const server = await request('time');
    const received = Date.now();
    if (typeof server === 'number') samples.push({ sent, received, server });
  }
  clockOffset = estimateClockOffset(samples);
}

// ---- oynatılacak kaynağın adresi ----------------------------------------------------

async function stremioUp() {
  try {
    const res = await fetch(`${STREMIO_BASE}/settings`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Kendi Stremio'su varsa doğrudan oynatır (relay yok, host'a yük yok);
// yoksa host'un relay'inden ham dosyayı alır - mpv her şeyi kendi çözdüğü için
// tarayıcıdaki gibi "Uyumlu mod" dönüştürmesine yine gerek kalmaz.
async function sourceFor(stream) {
  if (!stream) return null;
  if (stream.kind !== 'torrent') return { url: stream.url, source: 'http' };
  if (await stremioUp()) return { url: localTorrentUrl(stream), source: 'local' };
  const res = await request('requestRelay');
  if (res?.error) {
    log('relay alınamadı:', res.error);
    return null;
  }
  return { url: `${base}/relay/${roomId}/${res.relayKey}${torrentPath(stream)}`, source: 'relay' };
}

const myStream = () => {
  const me = room?.users?.find((u) => u.id === room.you);
  const id = me?.ownStreamId || room?.hostStreamId;
  return room?.streams?.find((s) => s.streamId === id) || null;
};

// ---- mpv ----------------------------------------------------------------------------

const mpv = createMpv({
  binary: mpvPath,
  pipeName: `birlikte-izle-${process.pid}`,
  args: ['--title=Birlikte İzle (prototip)', ...mpvArgs],
});
const local = { position: 0, paused: true, rate: 1, seeking: false, ready: false, idle: true, cacheStalled: false };
const programmatic = { pause: 0, seek: 0 };
let loadedStreamId = null;
let loadedSubId = null;
let lastSeekAt = 0;
let source = 'none';
let drift = null;

const PROPS = [
  [1, 'time-pos'], [2, 'pause'], [3, 'speed'], [4, 'seeking'],
  [5, 'core-idle'], [6, 'paused-for-cache'], [7, 'duration'],
];

function onProperty({ name, data }) {
  if (name === 'time-pos' && typeof data === 'number') {
    local.position = data;
    local.ready = true;
  } else if (name === 'pause') {
    const wasPaused = local.paused;
    local.paused = Boolean(data);
    if (wasPaused !== local.paused) onUserAction(local.paused ? 'pause' : 'play');
  } else if (name === 'speed') local.rate = Number(data) || 1;
  else if (name === 'seeking') local.seeking = Boolean(data);
  else if (name === 'core-idle') local.idle = Boolean(data);
  else if (name === 'paused-for-cache') local.cacheStalled = Boolean(data);
  else if (name === 'duration') local.duration = Number(data) || null;
}

// Kullanıcı mpv'de duraklattı/sardı: kilitliyse geri al, değilse odaya bildir.
function onUserAction(action) {
  const key = action === 'seek' ? 'seek' : 'pause';
  if (Date.now() - programmatic[key] < PROGRAMMATIC_MS) return;
  if (!room || !local.ready) return;
  if (!canControl(room.settings, room.you, room.hostUserId)) {
    log('oda kilitli - hareket geri alınıyor');
    applySync(true);
    return;
  }
  request('control', { action, position: local.position }).then((res) => {
    if (res?.error) log('kontrol reddedildi:', res.error);
  });
}

async function loadStream(force = false) {
  const stream = myStream();
  if (!stream) return;
  if (!force && stream.streamId === loadedStreamId) return;
  const picked = await sourceFor(stream);
  if (!picked) return;
  loadedStreamId = stream.streamId;
  source = picked.source;
  local.ready = false;
  log(`oynatılıyor (${picked.source}):`, (stream.title || stream.name || '').split('\n')[0]);
  await mpv.load(picked.url);
  loadedSubId = null;
  applySubtitle();
}

// Odanın ortak altyazısı: sunucudan VTT olarak çekilir, gecikme aynı işaretle uygulanır.
async function applySubtitle() {
  const sel = room?.hostSubtitle;
  if (!sel?.subId) {
    if (loadedSubId) await mpv.command('sub-remove').catch(() => {});
    loadedSubId = null;
    return;
  }
  if (sel.subId !== loadedSubId) {
    const url = `${base}/sub/${roomId}/${encodeURIComponent(sel.subId)}.vtt`;
    await mpv.command('sub-add', url, 'select').catch((err) => log('altyazı yüklenemedi:', err.message));
    loadedSubId = sel.subId;
  }
  await mpv.set('sub-delay', Number(sel.offset) || 0).catch(() => {});
}

// ---- senkron döngüsü ----------------------------------------------------------------

function applySync(immediate = false) {
  if (!room?.playback) return;
  const action = syncAction(room.playback, local, serverNow(), lastSeekAt, immediate ? 0 : Date.now());
  lastAction = action.type;
  if (action.drift !== undefined) drift = Math.round(action.drift * 1000) / 1000;
  if (action.type === 'seek') {
    lastSeekAt = Date.now();
    programmatic.seek = Date.now();
    mpv.seek(action.position).catch(() => {});
  } else if (action.type === 'pause') {
    programmatic.pause = Date.now();
    mpv.set('pause', true).catch(() => {});
    if (action.position !== undefined) {
      programmatic.seek = Date.now();
      mpv.seek(action.position).catch(() => {});
    }
  } else if (action.type === 'play') {
    programmatic.pause = Date.now();
    mpv.set('pause', false).catch(() => {});
  } else if (action.type === 'rate') {
    mpv.set('speed', action.rate).catch(() => {});
  }
}

function sendStatus() {
  if (!socket.connected || !room) return;
  request('status', {
    state: statusState({ loaded: local.ready, idle: local.idle, cacheStalled: local.cacheStalled }),
    source,
    drift,
    duration: local.duration ?? null,
    quality: myStream()?.quality ?? null,
  });
}

// ---- olaylar ------------------------------------------------------------------------

socket.on('connect', async () => {
  const res = await request('join', { roomId, userToken: randomUUID().replace(/-/g, ''), name });
  if (res?.error) {
    console.error('Odaya girilemedi:', res.error);
    process.exit(1);
  }
  room = res.snapshot;
  await calibrateClock();
  log(`odaya girildi: ${roomId} | ${room.users.length} kişi | saat farkı ${clockOffset} ms`);
  await mpv.start();
  // Dinleyici observe'dan ÖNCE bağlanmalı: mpv, gözlenen özelliğin ilk değerini hemen
  // yolluyor. Sonra bağlanırsa o ilk değerler kaçar ve durum başlangıç varsayımında
  // (örn. "duraklatılmış") takılı kalır.
  mpv.on('property-change', onProperty);
  for (const [id, prop] of PROPS) await mpv.observe(id, prop);
  mpv.on('exit', () => {
    log('mpv kapandı, çıkılıyor');
    process.exit(0);
  });
  await loadStream(true);
  applySync(true);
});

socket.on('playback', (d) => {
  room.playback = d.playback ?? d;
  room.autoPaused = d.autoPaused;
  applySync(true);
});
socket.on('hostStream', ({ hostStreamId, streams }) => {
  room.hostStreamId = hostStreamId;
  room.streams = streams;
  loadStream();
});
socket.on('content', (d) => {
  Object.assign(room, d);
  loadStream(true);
});
socket.on('users', ({ users }) => { room.users = users; });
socket.on('settings', (s) => { room.settings = s; });
socket.on('hostSubtitle', (sel) => {
  room.hostSubtitle = sel;
  applySubtitle();
});
socket.on('waiting', ({ userIds }) => {
  if (userIds?.includes(room?.you)) log('oda seni bekliyor');
});
socket.on('chat', (m) => log(`💬 ${m.name || 'sistem'}: ${m.text}`));
socket.on('roomClosed', () => bitir('oda kapandı'));
socket.on('kicked', () => bitir('odadan çıkarıldın'));
socket.on('replaced', () => bitir('oda başka yerde açıldı'));
socket.on('disconnect', (reason) => log('bağlantı koptu:', reason));

let lastAction = 'none';
setInterval(() => applySync(), TICK_MS);
setInterval(sendStatus, STATUS_MS);
setInterval(() => {
  if (debug) {
    const target = room?.playback ? expectedPosition(room.playback, serverNow()) : null;
    log(`[debug] konum=${local.position.toFixed(2)} hedef=${target?.toFixed(2)} sapma=${drift}`
      + ` | duraklat=${local.paused} hazır=${local.ready} boşta=${local.idle} önbellek=${local.cacheStalled}`
      + ` | odaDuraklat=${room?.playback?.paused} eylem=${lastAction}`);
    return;
  }
  if (room?.playback && !room.playback.paused && drift !== null) log(`sapma ${drift.toFixed(3)} sn | hız ${local.rate}`);
}, 5000);

async function bitir(reason) {
  log('çıkılıyor:', reason);
  await mpv.stop().catch(() => {});
  socket.close();
  process.exit(0);
}
process.on('SIGINT', () => bitir('kapatıldı'));
