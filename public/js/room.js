// Room page entry point: joins the room, keeps UI and player in sync with it.

import { io } from '/socket.io/socket.io.esm.min.js';
import { $, el, toast, formatTime, storage, randomToken, copyText, errorText } from './ui.js';
import { createSync } from './sync.js';
import { createPlayer, isStremioUp } from './player.js';
import { createChat } from './chat.js';
import { renderUsers, durationMismatch } from './users.js';
import { renderQuality, streamLabel, formatMbps } from './quality.js';
import { createBandwidthMeter, requiredMbps } from './bandwidth.js';
import { createSubs } from './subs.js';
import { STREMIO_BASE, torrentPath, hlsPath, localTorrentUrl } from './shared/stream-url.js';

// ---- identity --------------------------------------------------------------

const roomId = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
const hashParams = new URLSearchParams(location.hash.slice(1));
const hostToken = hashParams.get('host');
if (hostToken) {
  storage.set('userToken', hostToken);
  history.replaceState(null, '', location.pathname);
}
let userToken = hostToken || storage.get('userToken');
if (!userToken) {
  userToken = randomToken();
  storage.set('userToken', userToken);
}

const isTouch = matchMedia('(pointer: coarse)').matches;
const video = $('#video');
const playerEl = $('#player');
const state = {
  room: null,
  me: null,
  publicUrl: null,
  name: '',
  joinedOnce: false,
  ended: false,
  relayKey: null,
  relayError: null,
  blocked: false,
};

const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });
function request(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { error: 'timeout' } : res));
  });
}

// ---- derived state -----------------------------------------------------------

const me = () => state.room?.users.find((u) => u.id === state.me) || null;
const isHost = () => Boolean(state.room) && state.room.hostUserId === state.me;
const canControl = () => Boolean(state.room) && (!state.room.settings.locked || isHost());
const streamById = (id) => state.room?.streams.find((s) => s.streamId === id) || null;
const myStreamId = () => me()?.ownStreamId || state.room?.hostStreamId || null;
const myStream = () => streamById(myStreamId());
const userName = (id) => state.room?.users.find((u) => u.id === id)?.name || '?';

// ---- player / sources ----------------------------------------------------------

let hls = null;
function loadHls() {
  if (window.Hls) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = el('script', { src: '/vendor/hls.min.js' });
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

// Returns true when hls.js takes over the <video>; otherwise the player sets src.
function attachSource(url, opts = {}) {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (!url || !opts.hls || opts.native || !window.Hls?.isSupported()) return false;
  hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 30 });
  hls.on(window.Hls.Events.ERROR, (evt, data) => {
    if (data.fatal) player.fail('hls');
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return true;
}

async function ensureRelay() {
  if (state.relayKey) return state.relayKey;
  if (!isHost() && !state.room.settings.relayEnabled) {
    state.relayError = 'relayOff';
    return null;
  }
  const res = await request('requestRelay');
  if (res?.error) {
    state.relayError = res.error;
    return null;
  }
  state.relayError = null;
  state.relayKey = res.relayKey;
  return res.relayKey;
}

async function relayAlive(key) {
  try {
    const res = await fetch(`/relay/${roomId}/${key}/ping`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (res.ok) return true;
  } catch { /* fall through */ }
  state.relayError = 'hostStremioDown';
  return false;
}

function warm(url) {
  const ctrl = new AbortController();
  fetch(url, { mode: 'no-cors', signal: ctrl.signal }).then(() => ctrl.abort(), () => {});
  setTimeout(() => ctrl.abort(), 15_000);
}

async function compatSource(stream) {
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';
  if (stream.kind === 'http') {
    // Only the viewer's own Stremio can transcode a plain link, and only for native HLS players.
    if (nativeHls && (await isStremioUp())) {
      return { url: `${STREMIO_BASE}/url/${encodeURIComponent(stream.url)}/hls.m3u8`, source: 'http', hls: true, native: true };
    }
    return null;
  }
  if (!isHost() && nativeHls && (await isStremioUp())) {
    warm(localTorrentUrl(stream));
    return { url: `${STREMIO_BASE}${hlsPath(stream)}`, source: 'local', hls: true, native: true };
  }
  // The host's "relay" is its own Stremio, so it only helps when that is running.
  if (isHost() && !(await isStremioUp())) return null;
  const key = await ensureRelay();
  if (!key || (!isHost() && !(await relayAlive(key)))) return null;
  const source = isHost() ? 'local' : 'relay';
  const url = `/relay/${roomId}/${key}${hlsPath(stream)}`;
  if (nativeHls) return { url, source, hls: true, native: true };
  await loadHls().catch(() => {});
  return window.Hls?.isSupported() ? { url, source, hls: true } : null;
}

async function resolveFallback(stream, opts) {
  if (opts.compat) return compatSource(stream);
  if (stream.kind !== 'torrent' || isHost()) return null;
  const key = await ensureRelay();
  if (!key || !(await relayAlive(key))) return null;
  return { url: `/relay/${roomId}/${key}${torrentPath(stream)}`, source: 'relay' };
}

const player = createPlayer({
  video,
  resolveFallback,
  attachSource,
  onStatus: (st) => {
    if (st.state === 'error' && ['unsupported', 'decode'].includes(player.lastError())) startCompat();
    sendStatus();
    renderNotice();
    renderControls();
  },
});

let loaded = { streamId: undefined, compat: false };
function loadMyStream(force = false) {
  const s = myStream();
  const id = s?.streamId ?? null;
  if (!force && id === loaded.streamId) return;
  const compat = Boolean(s?.notWebReady);
  loaded = { streamId: id, compat };
  mediaProblem = null;
  player.load(s, compat ? { forceFallback: true, compat: true } : {});
  renderCompatButton();
}

function startCompat() {
  const s = myStream();
  if (!s || loaded.compat) return;
  loaded.compat = true;
  mediaProblem = null;
  toast('Uyumlu moda geçiliyor…');
  player.load(s, { forceFallback: true, compat: true });
  renderCompatButton();
}

function stopCompat() {
  const s = myStream();
  if (!s || !loaded.compat) return;
  loaded.compat = false;
  mediaProblem = null;
  toast('Normal moda dönülüyor…');
  player.load(s, {});
  renderCompatButton();
}

// Codec problems often fail silently: unsupported audio (AC3/DTS) plays
// picture without sound, unsupported video (HEVC) plays sound without picture.
let mediaProblem = null; // 'audio' | 'video' | null
function detectMediaProblem() {
  if (loaded.compat || video.paused || video.readyState < 3 || video.currentTime < 3) return;
  let problem = null;
  if (video.videoWidth === 0) problem = 'video';
  else if ('webkitAudioDecodedByteCount' in video) {
    if (video.webkitAudioDecodedByteCount === 0 && video.webkitVideoDecodedByteCount > 0) problem = 'audio';
  } else if ('mozHasAudio' in video && !video.mozHasAudio) problem = 'audio';
  if (problem === mediaProblem) return;
  mediaProblem = problem;
  renderCompatButton();
  if (problem) toast(problem === 'audio' ? 'Ses gelmiyor gibi görünüyor.' : 'Görüntü gelmiyor gibi görünüyor.', 5000);
}
setInterval(detectMediaProblem, 2000);

function renderCompatButton() {
  const btn = $('#compat-btn');
  const show = Boolean(player.stream()) && (loaded.compat || mediaProblem);
  btn.hidden = !show;
  btn.classList.toggle('active', loaded.compat);
  btn.textContent = loaded.compat ? 'Normal moda dön' : 'Ses/görüntü sorunu mu?';
  btn.title = loaded.compat
    ? 'Dönüştürmeyi kapatıp videoyu doğrudan oynat'
    : 'Uyumlu moda geç: Stremio videoyu tarayıcının açabileceği biçime dönüştürür';
}

function sendStatus() {
  if (!state.room || state.ended || !socket.connected) return;
  const st = player.status();
  request('status', {
    state: st.state,
    source: st.source,
    drift: sync.drift(),
    duration: player.duration(),
    quality: myStream()?.quality ?? null,
  });
}
setInterval(sendStatus, 2000);

// ---- sync -------------------------------------------------------------------------

const sync = createSync({
  video,
  request,
  canControl,
  onBlocked: () => {
    state.blocked = true;
    renderNotice();
  },
  onError: (code) => toast(errorText(code)),
});

// ---- rendering ----------------------------------------------------------------------

const chat = createChat({
  list: $('#chat-list'),
  form: $('#chat-form'),
  input: $('#chat-input'),
  request,
  meId: () => state.me,
});

const subs = createSubs({
  panel: $('#subs-panel'),
  video,
  playerEl,
  roomId,
  request,
  isHost,
  userToken,
});

function renderHeader() {
  const { meta } = state.room;
  const title = meta?.name || state.room.contentId;
  $('#title').textContent = title;
  document.title = `${title} · Birlikte İzle`;
  const poster = $('#poster');
  poster.hidden = !meta?.poster;
  if (meta?.poster) poster.src = meta.poster;
  const count = state.room.users.filter((u) => u.connected).length;
  $('#subtitle').textContent = `Oda ${roomId} · ${count} kişi${isHost() ? ' · host sensin' : ''}`;
}

function renderUsersTab() {
  const count = renderUsers($('#user-list'), state.room, state.me, {
    streamLabel: (u) => streamLabel(streamById(u.ownStreamId || state.room.hostStreamId)),
    onKick: async (u) => {
      if (!confirm(`${u.name} odadan çıkarılsın mı? Tekrar giremez.`)) return;
      const res = await request('kick', { userId: u.id });
      if (res?.error) toast(errorText(res.error));
    },
  });
  $('#user-count').textContent = String(count);
}

let mismatchWarned = false;
// ---- download speed vs. file bitrate ----
const meter = createBandwidthMeter(video);
let speed = { slow: false, rate: null, need: null, have: null };

// All streams are the same title, so one duration (ours or the host's) fits all.
function contentDuration() {
  const own = player.duration();
  if (own) return own;
  const host = state.room?.users.find((u) => u.id === state.room.hostUserId);
  return Number.isFinite(host?.status?.duration) ? host.status.duration : null;
}

function speedText() {
  const numbers = speed.have !== null && speed.need !== null
    ? ` (~${formatMbps(speed.have)} Mbps geliyor, bu dosya ~${formatMbps(speed.need)} Mbps istiyor)`
    : '';
  const why = player.status().source === 'relay' ? " Host'un upload hızı yetmiyor olabilir." : '';
  return `⚠️ İndirme hızın bu dosyaya yetişmiyor${numbers}, video sık donabilir.${why} Aşağıdan daha küçük bir dosya seçebilirsin.`;
}

function checkSpeed() {
  if (!state.room || state.ended) return;
  const rate = meter.rate();
  const need = requiredMbps(myStream()?.sizeBytes, player.duration());
  const ahead = meter.ahead();
  let slow = speed.slow;
  if (rate === null) slow = false;
  else if (rate < 0.95 && ahead < 60) slow = true;
  else if (rate >= 1.1 || ahead >= 60) slow = false;
  const have = rate !== null && need !== null ? rate * need : null;
  const changed = slow !== speed.slow
    || (have === null) !== (speed.have === null)
    || (have !== null && Math.abs(have - speed.have) > speed.have * 0.15);
  if (slow && !speed.slow) toast(speedText(), 8000);
  speed = { slow, rate, need, have };
  const btn = $('#speed-warn');
  btn.hidden = !slow;
  btn.textContent = have !== null && need !== null
    ? `⚠️ İndirme yetişmiyor: ${formatMbps(have)} / ${formatMbps(need)} Mbps`
    : '⚠️ İndirme hızı yetişmiyor';
  btn.title = speedText();
  if (changed) renderQualityTab();
}
setInterval(checkSpeed, 3000);

function renderQualityTab() {
  renderQuality($('#quality-list'), state.room, {
    myStreamId: myStreamId(),
    isHost: isHost(),
    onPickOwn: async (streamId) => {
      const res = await request('setOwnStream', { streamId });
      if (res?.error) toast(errorText(res.error));
    },
    onPickHost: async (streamId) => {
      const s = streamById(streamId);
      if (s?.kind === 'http' && !confirm(DEBRID_WARNING)) return;
      const res = await request('setHostStream', { streamId });
      if (res?.error) toast(errorText(res.error));
    },
    needFor: (s) => requiredMbps(s.sizeBytes, contentDuration()),
    have: speed.have,
  });
  const host = state.room.users.find((u) => u.id === state.room.hostUserId);
  const mine = me();
  const mismatch = Boolean(mine && host && mine.id !== host.id && durationMismatch(mine, host));
  const warnings = [];
  if (mismatch) warnings.push("⚠️ Bu sürümün süresi host'unkinden farklı, senkron kayabilir. Mümkünse host'la aynı stream'i seç.");
  if (speed.slow) warnings.push(speedText());
  const box = $('#quality-warning');
  box.hidden = warnings.length === 0;
  box.textContent = warnings.join('\n');
  if (mismatch && !mismatchWarned) toast("Senin sürümün host'unkinden farklı, senkron kayabilir.", 5000);
  mismatchWarned = mismatch;
}

const DEBRID_WARNING = 'Bu bir doğrudan link (ör. Real-Debrid). Linkte hesabının anahtarı olabilir: arkadaşların senin hesabını kullanır ve bazı servisler farklı IP\'lerden aynı anda kullanımı ban sebebi sayar. Devam edilsin mi?';

function renderBanner() {
  const ids = state.room?.waitingUserIds || [];
  const banner = $('#banner');
  banner.hidden = ids.length === 0;
  if (!ids.length) return;
  $('#banner-text').textContent = `⏳ ${ids.map(userName).join(', ')} bekleniyor…`;
  $('#banner-skip').hidden = !isHost();
}

function button(text, onclick, primary = false) {
  return el('button', { type: 'button', class: primary ? 'primary' : '', text, onclick });
}

function renderNotice() {
  const box = $('#notice');
  const actions = [];
  let text = null;
  const st = player.status();

  if (state.blocked) {
    text = 'Tarayıcı otomatik oynatmayı engelledi.';
    actions.push(button('▶ Oynat', () => {
      state.blocked = false;
      video.play().catch(() => {});
      sync.reapply();
      renderNotice();
    }, true));
  } else if (st.state === 'noStremio') {
    text = isTouch
      ? 'Bu cihazda Stremio bulunamadı.\nTelefonda videoyu host üzerinden izleyebilirsin.'
      : 'Stremio açık değil.\nBilgisayarında Stremio uygulamasını aç, sayfa kendiliğinden bağlanır.\nTarayıcı "yerel ağdaki cihazlara erişim" izni sorarsa İzin ver\'e bas.';
    if (state.relayError && !isHost()) text += `\n\nHost üzerinden izleme: ${errorText(state.relayError)}`;
    if (state.room?.settings.relayEnabled && !isHost()) {
      actions.push(button('📶 Host üzerinden izle', () => {
        state.relayError = null;
        player.reload();
      }, true));
    }
  } else if (st.state === 'error') {
    const reason = player.lastError();
    text = {
      unsupported: 'Tarayıcın bu videoyu açamıyor.',
      decode: 'Video çözülemedi.',
      network: 'Videoya ulaşılamadı.',
      timeout: 'Video 60 saniyedir başlamadı. Torrent\'te yeterli kaynak olmayabilir.',
      hls: 'Uyumlu mod da videoyu açamadı.',
      compat: 'Uyumlu mod bu cihazda kullanılamıyor.',
    }[reason] || 'Video açılamadı.';
    text += isHost() ? '\nKalite sekmesinden başka bir stream seçebilirsin.' : '\nKalite sekmesinden başka bir stream deneyebilirsin.';
    if (!loaded.compat) actions.push(button('🛠 Uyumlu modu dene', startCompat, true));
    actions.push(button('Tekrar dene', () => loadMyStream(true)));
    actions.push(button('Kalite', () => selectTab('quality')));
  }

  box.hidden = !text;
  $('#notice-text').textContent = text || '';
  $('#notice-actions').replaceChildren(...actions);
}

function renderControls() {
  const control = canControl();
  $('#btn-play').textContent = sync.intendsToPlay() ? '⏸' : '▶';
  $('#btn-play').disabled = !control;
  $('#seek').disabled = !control;
  $('#lock-hint').hidden = control;
  renderCompatButton();
}

function updateHostUi() {
  $('#open-settings').hidden = !isHost();
  renderHeader();
  renderControls();
  renderBanner();
  subs.rerender();
}

function renderAll() {
  updateHostUi();
  renderUsersTab();
  renderQualityTab();
}

// ---- socket events -------------------------------------------------------------------

function applySnapshot(snap, publicUrl) {
  const hadRelay = player.status().source === 'relay';
  state.room = snap;
  state.me = snap.you;
  state.publicUrl = publicUrl;
  state.relayKey = null; // the server drops relay grants on disconnect
  $('#join').hidden = true;
  $('#app').hidden = false;
  chat.render(snap.chat);
  subs.setList(snap.subtitles);
  subs.setHost(snap.hostSubtitle);
  renderAll();
  sync.setPlayback(snap.playback, snap.autoPaused);
  sync.calibrate().then(() => sync.setPlayback(state.room.playback, state.room.autoPaused));
  loadMyStream(hadRelay);
  state.joinedOnce = true;
}

const JOIN_ERRORS = {
  notFound: 'Oda bulunamadı veya kapandı.',
  banned: 'Bu odadan çıkarıldın.',
  badName: 'Geçerli bir ad yaz.',
  tooMany: 'Çok fazla deneme yapıldı, biraz bekle.',
};

function end(message) {
  if (state.ended) return;
  state.ended = true;
  socket.disconnect();
  player.load(null);
  sync.stop();
  $('#ended-text').textContent = message;
  $('#app').hidden = true;
  $('#join').hidden = true;
  $('#ended').hidden = false;
}

socket.on('connect', async () => {
  const res = await request('join', { roomId, userToken, name: state.name });
  if (!res?.error) return applySnapshot(res.snapshot, res.publicUrl);
  const message = JOIN_ERRORS[res.error] || errorText(res.error);
  if (state.joinedOnce) return end(message);
  socket.disconnect();
  $('#join-error').textContent = message;
  $('#join-error').hidden = false;
});

socket.on('playback', (d) => {
  const prev = state.room.playback;
  state.room.playback = d.playback;
  state.room.autoPaused = d.autoPaused;
  sync.setPlayback(d.playback, d.autoPaused);
  renderControls();
  if (d.by && d.by !== me()?.name) {
    const verb = prev.paused !== d.playback.paused ? (d.playback.paused ? 'duraklattı' : 'oynattı') : `${formatTime(d.playback.position)} konumuna sardı`;
    toast(`${d.by} ${verb}`);
  }
});

socket.on('waiting', ({ userIds }) => {
  state.room.waitingUserIds = userIds;
  renderBanner();
});

socket.on('users', ({ users }) => {
  state.room.users = users;
  renderUsersTab();
  renderQualityTab();
  renderBanner();
  renderHeader();
  loadMyStream();
});

socket.on('chat', (m) => chat.add(m));

socket.on('hostStream', ({ hostStreamId, streams }) => {
  state.room.hostStreamId = hostStreamId;
  state.room.streams = streams;
  renderQualityTab();
  renderUsersTab();
  loadMyStream();
});

socket.on('subtitles', ({ subtitles }) => {
  state.room.subtitles = subtitles;
  subs.setList(subtitles);
});

socket.on('hostSubtitle', (sel) => {
  state.room.hostSubtitle = sel;
  subs.setHost(sel);
});

socket.on('settings', (s) => {
  state.room.settings = s;
  updateHostUi();
  renderNotice();
});

socket.on('hostChanged', ({ hostUserId }) => {
  state.room.hostUserId = hostUserId;
  state.room.users = state.room.users.map((u) => ({ ...u, isHost: u.id === hostUserId }));
  renderAll();
  if (hostUserId === state.me) toast('Artık host sensin.');
});

socket.on('publicUrl', (url) => {
  const changed = state.publicUrl && state.publicUrl !== url;
  state.publicUrl = url;
  if (changed && isHost()) toast('Tünel adresi değişti. Arkadaşlarına yeni linki gönder (🔗 Linki kopyala).', 8000);
});

socket.on('relayRevoked', () => {
  state.relayKey = null;
  toast('Host, relay iznini kaldırdı.');
  if (player.status().source === 'relay') loadMyStream(true);
});

socket.on('kicked', () => end('Odadan çıkarıldın.'));
socket.on('replaced', () => end('Bu oda başka bir sekmede açıldı.'));
socket.on('roomClosed', () => end('Oda kapandı.'));
socket.on('disconnect', (reason) => {
  if (state.ended) return;
  if (reason === 'io server disconnect') return end('Bağlantın sunucu tarafından kapatıldı.');
  toast('Bağlantı koptu, yeniden bağlanılıyor…', 5000);
});

// ---- controls --------------------------------------------------------------------------

let seeking = false;
const seek = $('#seek');
$('#btn-play').addEventListener('click', () => (canControl() ? sync.toggle() : toast(errorText('locked'))));
// Seek bar: played part in accent colour, downloaded (buffered) parts lighter.
function renderSeekBar() {
  const bar = $('#seek-bar');
  const d = video.duration;
  if (!Number.isFinite(d) || d <= 0) {
    bar.style.background = '';
    return;
  }
  const pct = (t) => Math.min(100, Math.max(0, (t / d) * 100));
  const played = pct(seeking ? Number(seek.value) : video.currentTime);
  const EMPTY = 'rgba(255,255,255,.18)';
  const LOADED = 'rgba(255,255,255,.5)';
  const stops = [`var(--accent) 0% ${played}%`];
  let cursor = played;
  for (let i = 0; i < video.buffered.length; i++) {
    const end = pct(video.buffered.end(i));
    if (end <= cursor) continue;
    const start = Math.max(pct(video.buffered.start(i)), cursor);
    stops.push(`${EMPTY} ${cursor}% ${start}%`, `${LOADED} ${start}% ${end}%`);
    cursor = end;
  }
  stops.push(`${EMPTY} ${cursor}% 100%`);
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}
video.addEventListener('progress', renderSeekBar);
video.addEventListener('emptied', renderSeekBar);
setInterval(renderSeekBar, 1000);

seek.addEventListener('input', () => {
  seeking = true;
  $('#time').textContent = `${formatTime(Number(seek.value))} / ${formatTime(video.duration)}`;
  renderSeekBar();
});
seek.addEventListener('change', () => {
  seeking = false;
  sync.seek(Number(seek.value));
});
video.addEventListener('timeupdate', () => {
  if (!seeking) seek.value = String(video.currentTime);
  $('#time').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  renderSeekBar();
});
video.addEventListener('durationchange', () => {
  seek.max = String(Number.isFinite(video.duration) ? video.duration : 0);
  sendStatus();
  if (state.room) renderQualityTab();
});
video.addEventListener('play', renderControls);
video.addEventListener('pause', renderControls);

const volume = $('#volume');
video.volume = Number(storage.get('volume') ?? 1);
volume.value = String(video.volume);
volume.addEventListener('input', () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  storage.set('volume', volume.value);
});
$('#btn-mute').addEventListener('click', () => {
  video.muted = !video.muted;
});
video.addEventListener('volumechange', () => {
  $('#btn-mute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
});

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (playerEl.requestFullscreen) return playerEl.requestFullscreen().catch(() => {});
  if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS
}
$('#btn-fs').addEventListener('click', toggleFullscreen);
video.addEventListener('dblclick', toggleFullscreen);
$('#compat-btn').addEventListener('click', () => (loaded.compat ? stopCompat() : startCompat()));
$('#speed-warn').addEventListener('click', () => selectTab('quality'));
$('#banner-skip').addEventListener('click', async () => {
  const res = await request('skipWaiting');
  if (res?.error) toast(errorText(res.error));
});

// Hide controls while watching.
let idleTimer = null;
function wake() {
  playerEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused) playerEl.classList.add('idle');
  }, 3000);
}
playerEl.addEventListener('mousemove', wake);
playerEl.addEventListener('touchstart', wake, { passive: true });

document.addEventListener('keydown', (e) => {
  if (!state.room || e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.key === 'k') {
    e.preventDefault();
    if (canControl()) sync.toggle();
  } else if (e.key === 'f') toggleFullscreen();
  else if (e.key === 'm') video.muted = !video.muted;
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && canControl()) {
    sync.seek(Math.max(0, video.currentTime + (e.key === 'ArrowRight' ? 10 : -10)));
  }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => canControl() && !sync.intendsToPlay() && sync.toggle());
  navigator.mediaSession.setActionHandler('pause', () => canControl() && sync.intendsToPlay() && sync.toggle());
}

// ---- tabs, header actions, settings ------------------------------------------------------

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const body of document.querySelectorAll('.tab-body')) body.hidden = body.dataset.tab !== name;
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

$('#copy-link').addEventListener('click', async () => {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const base = state.publicUrl || (local ? null : location.origin);
  if (!base) return toast('Tünel henüz hazır değil. Paneldeki tünel durumunu kontrol et.', 5000);
  if (await copyText(`${base}/room/${roomId}`)) toast('Link kopyalandı.');
});

const dialog = $('#settings-dialog');
$('#open-settings').addEventListener('click', () => {
  const s = state.room.settings;
  $('#set-locked').checked = s.locked;
  for (const r of dialog.querySelectorAll('input[name="waitMode"]')) r.checked = r.value === s.waitMode;
  $('#set-relay').checked = s.relayEnabled;
  $('#set-relay-limit').value = String(s.relayLimit);
  dialog.showModal();
});
dialog.addEventListener('change', async () => {
  const res = await request('settings', {
    locked: $('#set-locked').checked,
    waitMode: dialog.querySelector('input[name="waitMode"]:checked')?.value,
    relayEnabled: $('#set-relay').checked,
    relayLimit: Math.max(0, Math.min(10, Number($('#set-relay-limit').value) || 0)),
  });
  if (res?.error) toast(errorText(res.error));
});

$('#ended-reload').addEventListener('click', () => location.reload());

// ---- join -------------------------------------------------------------------------------------

if (!/^[A-Z0-9]{6}$/.test(roomId)) {
  $('#join-sub').textContent = 'Geçersiz oda linki. Host\'tan linki tekrar iste.';
  $('#join-form button').disabled = true;
}
const nameInput = $('#join-name');
nameInput.value = storage.get('name') || hashParams.get('name') || '';
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  state.name = name;
  storage.set('name', name);
  $('#join-error').hidden = true;
  video.play().catch(() => {}); // unlocks media playback on this gesture (iOS)
  socket.connect();
});
