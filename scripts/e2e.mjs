// Uçtan uca test: gerçek Stremio ve addon'larla ayrı bir sunucu (7100/7101, tünelsiz, ayrı veri
// klasörü, TEST_INSTANCE) açıp oda akışını dener: kaynak listesi, otomatik seçim, oda açma,
// katılma, ölçümler, telefonun kaynak testi, tanı kaydı, sarma kapısı. Açık sunucuna ve
// izlediğin torrent'lere dokunmaz; testin Stremio'da açtığı torrent'ler sonunda kapatılır.
// Çalıştır: npm run e2e  (Stremio açık olmalı; ~1-2 dk)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { otomatikSec } from '../public/js/shared/kaynak-sec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = 7100;
const PANEL = 7101;
const ICERIK = { type: 'series', id: process.env.E2E_ID || 'tt14688458:2:3' };
// MOTOR=torrserver MOTOR_URL=http://127.0.0.1:11471 ile Stremio yerine TorrServer motoruyla (Stremio açıkken de).
const STREMIO = process.env.MOTOR_URL || 'http://127.0.0.1:11470';
const MOTOR = process.env.MOTOR || 'stremio';

let hata = 0;
const ok = (kosul, ad, ayrinti = '') => {
  console.log(`${kosul ? 'GEÇTİ ' : 'KALDI '} ${ad}${ayrinti ? `  (${ayrinti})` : ''}`);
  if (!kosul) hata += 1;
};
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const acikTorrentler = async () => Object.keys(await (await fetch(`${STREMIO}/stats.json`)).json().catch(() => ({})));

// ---- hazırlık ----
if (MOTOR === 'stremio') {
  try { await fetch(`${STREMIO}/settings`, { signal: AbortSignal.timeout(3000) }); } catch {
    console.log('Stremio kapalı: önce Stremio\'yu aç.');
    process.exit(2);
  }
}
const veri = fs.mkdtempSync(path.join(os.tmpdir(), 'birlikte-e2e-'));
// TorrServer motoru: program her seferinde indirilmesin (data/araclar'dakini kopyala).
const tsExe = path.join(ROOT, 'data', 'araclar', 'TorrServer.exe');
if (MOTOR === 'torrserver' && fs.existsSync(tsExe)) {
  fs.mkdirSync(path.join(veri, 'araclar'), { recursive: true });
  fs.copyFileSync(tsExe, path.join(veri, 'araclar', 'TorrServer.exe'));
}
for (const f of ['config.json', 'tercih.json', 'trackerlar.json']) {
  const kaynak = path.join(ROOT, 'data', f);
  if (fs.existsSync(kaynak)) fs.copyFileSync(kaynak, path.join(veri, f));
}
const onceki = new Set(await acikTorrentler().catch(() => []));
const sunucu = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PUBLIC_PORT: String(PUB), PANEL_PORT: String(PANEL), NO_TUNNEL: '1', TEST_INSTANCE: '1', DATA_DIR: veri, SAHIPSIZ_MS: '3000', MOTOR, ...(process.env.MOTOR_URL ? { MOTOR_URL: process.env.MOTOR_URL } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let sunucuCikti = '';
sunucu.stdout.on('data', (d) => { sunucuCikti += d; });
sunucu.stderr.on('data', (d) => { sunucuCikti += d; });

async function temizle() {
  sunucu.kill();
  for (const h of await acikTorrentler().catch(() => [])) {
    if (!onceki.has(h)) await fetch(`${STREMIO}/${h}/remove`).catch(() => {});
  }
  fs.rmSync(veri, { recursive: true, force: true });
}

try {
  for (let i = 0; i < 40; i++) {
    if (await fetch(`http://127.0.0.1:${PANEL}/api/ping`).then((r) => r.ok).catch(() => false)) break;
    await bekle(250);
  }
  const panelHtml = await (await fetch(`http://127.0.0.1:${PANEL}/new?type=${ICERIK.type}&id=${ICERIK.id}`)).text();
  const key = panelHtml.match(/name="panel-key" content="([^"]+)"/)?.[1];
  ok(Boolean(key), 'panel açıldı');
  const H = { 'x-panel-key': key, 'content-type': 'application/json', origin: `http://127.0.0.1:${PANEL}` };

  // ---- kaynak listesi ----
  const satirlar = (await (await fetch(`http://127.0.0.1:${PANEL}/api/streams?type=${ICERIK.type}&id=${ICERIK.id}`, { headers: H })).text())
    .trim().split('\n').map((l) => JSON.parse(l));
  const streams = satirlar.filter((l) => l.type === 'addon').flatMap((l) => l.streams);
  const torrents = streams.filter((s) => s.kind === 'torrent');
  ok(torrents.length > 0, 'addon\'lardan torrent geldi', `${torrents.length} torrent`);
  ok(satirlar.some((l) => l.type === 'done'), 'liste tamamlandı');

  const secim = otomatikSec(streams, '1080p');
  ok(secim?.quality === '1080p' || !torrents.some((s) => s.quality === '1080p'), 'otomatik seçim tercih kalitesinden', `${secim?.quality} · ${secim?.seeders} seed`);
  const hafiza = await fetch(`http://127.0.0.1:${PANEL}/api/kaynak-hafiza?id=${ICERIK.id}`, { headers: H });
  ok(hafiza.ok, 'kaynak hafızası ucu');

  // ---- arka planda torrent kalmasın (sorun: "hiçbir şey açık değilken Stremio internet yiyor") ----
  const icerikHash = new Set(torrents.map((s) => s.infoHash));
  const icerikAcik = async () => (await acikTorrentler()).filter((h) => icerikHash.has(h) && !onceki.has(h));
  await bekle(4000);
  const isinan = await icerikAcik();
  ok(isinan.length > 0, 'oda aç ekranında en iyi kaynaklar önceden açıldı', `${isinan.length} torrent`);
  await fetch(`http://127.0.0.1:${PANEL}/api/sayfa-kapandi`, { method: 'POST', headers: H, body: JSON.stringify(ICERIK) });
  await bekle(3000);
  ok((await icerikAcik()).length === 0, 'oda aç sayfası kapanınca hepsi kapandı');
  ok(await fetch(`${STREMIO}/settings`).then((r) => r.ok).catch(() => false), 'Stremio çökmedi (toplu kapatma)');

  // ---- oda ----
  const olcum = { infoHash: secim.infoHash, peers: 12, downMbps: 30 };
  const oda = await (await fetch(`http://127.0.0.1:${PANEL}/api/rooms`, {
    method: 'POST', headers: H, body: JSON.stringify({ ...ICERIK, streamId: secim.streamId, olcumler: [olcum] }),
  })).json();
  ok(Boolean(oda.roomId), 'oda açıldı', oda.roomId);
  const hostToken = new URLSearchParams(new URL(oda.roomUrl).hash.slice(1)).get('host');

  const baglan = () => io(`http://127.0.0.1:${PUB}`, { transports: ['websocket'] });
  const iste = (s, ev, p = {}, ms = 8000) => new Promise((r) => s.timeout(ms).emit(ev, p, (e, res) => r(e ? { error: 'timeout' } : res)));
  const host = baglan();
  const hj = await iste(host, 'join', { roomId: oda.roomId, userToken: hostToken, name: 'TestHost' });
  ok(!hj.error && hj.snapshot.hostUserId === hj.snapshot.you, 'host odaya girdi');
  const misafir = baglan();
  const mj = await iste(misafir, 'join', { roomId: oda.roomId, userToken: `e2e-misafir-${Date.now()}`, name: 'TestTelefon' });
  ok(!mj.error, 'misafir odaya girdi');

  const ol = await iste(misafir, 'olcumler');
  ok(ol.list?.some((x) => x.streamId === secim.streamId && x.downMbps === 30), 'oda aç ölçümleri odaya geçti');

  // ---- sarma kapısı ----
  const hId = hj.snapshot.you;
  const mId = mj.snapshot.you;
  const sonPlayback = () => new Promise((r) => misafir.once('playback', r));
  const hazir = (rev) => Promise.all([
    iste(host, 'status', { state: 'ready', source: 'local', rev }),
    iste(misafir, 'status', { state: 'ready', source: 'local', rev }),
  ]);
  await hazir(hj.snapshot.rev);
  let p = sonPlayback();
  await iste(host, 'control', { action: 'play', position: 0 });
  let pb = await p;
  p = sonPlayback();
  await hazir(pb.rev);
  pb = await p;
  ok(!pb.playback.paused, 'herkes hazır olunca oynuyor');
  p = sonPlayback();
  await iste(host, 'control', { action: 'seek', position: 600 });
  pb = await p;
  ok(pb.playback.paused && pb.autoPaused && pb.playback.position === 600, 'sarınca oda herkesi bekliyor');
  p = sonPlayback();
  await iste(host, 'status', { state: 'ready', source: 'local', rev: pb.rev });
  const hala = await Promise.race([p.then(() => 'geldi'), bekle(500).then(() => 'yok')]);
  ok(hala === 'yok', 'biri gelmeden devam etmiyor');
  await iste(misafir, 'status', { state: 'ready', source: 'local', rev: pb.rev });
  pb = await p;
  ok(!pb.playback.paused, 'herkes yeni yere gelince devam ediyor');

  // ---- tanı kaydı ----
  await iste(misafir, 'tani', { entries: [{ t: Date.now(), k: 'durum', s: 'buffering' }] });
  const tk = await iste(host, 'taniOku', { userId: mId });
  ok(tk.entries?.length === 1, 'tanı kaydı host\'ta görünüyor');
  ok(fs.existsSync(path.join(veri, 'tani', `${oda.roomId}.log`)), 'tanı kaydı dosyaya yazıldı');
  ok((await iste(misafir, 'taniOku', { userId: hId })).error === 'notHost', 'misafir başkasının kaydını göremiyor');

  // ---- telefonun kaynak testi (gerçek Stremio'da ölçüm, ~20-40 sn) ----
  const t0 = Date.now();
  const test = await iste(misafir, 'kaynakTest', { quality: '1080p' }, 90_000);
  const canli = (test.sonuclar || []).filter((r) => r.alive);
  ok(Array.isArray(test.sonuclar) && test.sonuclar.length > 0, 'telefon kaynak testi çalıştı',
    `${test.sonuclar?.length} aday, ${canli.length} veri verdi, ${Math.round((Date.now() - t0) / 1000)} sn`);
  const ol2 = await iste(misafir, 'olcumler');
  ok((ol2.list?.length || 0) >= (test.sonuclar?.length || 0), 'test ölçümleri odada saklandı', `${ol2.list?.length} ölçüm`);

  // ---- herkes çıkınca odanın torrent'leri kapanıyor (sorun: "odadan çıkınca kapatılsın") ----
  ok((await icerikAcik()).length > 0, 'odada torrent açık');
  host.close();
  misafir.close();
  const cikis = Date.now();
  let kalan = await icerikAcik();
  while (kalan.length && Date.now() - cikis < 90_000) {
    await bekle(3000);
    kalan = await icerikAcik();
  }
  ok(kalan.length === 0, "herkes çıkınca odanın torrent'leri kapandı", `${Math.round((Date.now() - cikis) / 1000)} sn`);
  ok(await fetch(`${STREMIO}/settings`).then((r) => r.ok).catch(() => false), 'Stremio hâlâ ayakta');
} catch (err) {
  ok(false, 'beklenmeyen hata', err.message);
  console.log(sunucuCikti.slice(-2000));
} finally {
  await temizle();
}
console.log(hata ? `\n${hata} test KALDI` : '\nHepsi geçti');
process.exit(hata ? 1 : 0);
