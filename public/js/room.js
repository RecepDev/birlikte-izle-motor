// Room page entry point: joins the room, keeps UI and player in sync with it.

import { io } from '/socket.io/socket.io.esm.min.js';
import { $, el, toast, formatTime, formatSize, storage, randomToken, copyText, errorText } from './ui.js';
import { createSync } from './sync.js';
import { createPlayer, isStremioUp } from './player.js';
import { createChat } from './chat.js';
import { renderUsers, durationMismatch } from './users.js';
import { renderQuality, streamLabel, formatMbps } from './quality.js';
import { requiredMbps, createDownloadMeter } from './bandwidth.js';
import { createSubs } from './subs.js';
import { setIcon } from './icons.js';
import { STREMIO_BASE, torrentPath, hlsV2Path, HLS_4K_WIDTH, HLS_VIDEO_CODECS, COMPAT_WIDTHS } from './shared/stream-url.js';
import { langLabel } from './shared/subtitle-text.js';
import { browserCodecs, isRealSafari } from './codecs.js';
import { checkHardware, gpuName, HW_HELP } from './hwaccel.js';
import { probeDevice, evaluate as evaluateCompat, autoScanTargets } from './compat.js';
import { createCompatScreen } from './compat-view.js';

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
// Masaüstü uygulaması (mpv): her biçimi açıyor, uyumlu mod ve uyarıları hiç gösterilmiyor.
// Köprü sayfadan sonra kurulabildiği için her seferinde bakılıyor.
const desktopApp = () => Boolean(window.masaustuSes) && !window.mobilCihaz;
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
  hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => subs?.rerender());
  hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, () => subs?.rerender());
  hls.loadSource(url);
  hls.attachMedia(video);
  return true;
}

// Multi-audio files: hls.js exposes alternate audio renditions (compat mode);
// native playback exposes them via the browser's own AudioTrackList when the
// container/browser support it (Safari's native HLS, some local mp4/webm).
// Masaüstü kabuğu ses parçalarını mpv'den bildirir.
window.addEventListener('masaustu-sesler', () => subs?.rerender());
// Telefon dosyanın sesini çözemiyor (ör. DTS): yalnızca sesi dönüştüren moda geç.
// Görüntü kopyalanıyor (telefon HEVC'yi açabiliyor), kalite düşmüyor.
window.addEventListener('masaustu-ses-yok', () => {
  toast('Bu telefon dosyanın sesini çözemiyor (ör. DTS). Ses dönüştürülerek açılıyor, görüntü aynı kalıyor.', 7000);
  startCompat({ allowReencode: false });
});
if ('audioTracks' in video) {
  const onAudioChange = () => subs?.rerender();
  video.audioTracks.addEventListener('addtrack', onAudioChange);
  video.audioTracks.addEventListener('removetrack', onAudioChange);
  video.audioTracks.addEventListener('change', onAudioChange);
}

function audioTracksList() {
  const masaustu = window.masaustuSes?.liste();
  if (masaustu?.length > 1) {
    return masaustu.map((t, i) => ({
      id: t.id,
      label: t.title || (t.lang ? langLabel(t.lang) : `Ses ${i + 1}`),
      active: t.active,
    }));
  }
  if (hls?.audioTracks?.length > 1) {
    return hls.audioTracks.map((t, i) => ({
      id: String(i),
      label: t.name && t.name !== 'main' ? t.name : t.lang ? langLabel(t.lang) : `Ses ${i + 1}`,
      active: i === hls.audioTrack,
    }));
  }
  if (video.audioTracks?.length > 1) {
    return [...video.audioTracks].map((t, i) => ({
      id: t.id,
      label: t.label || (t.language ? langLabel(t.language) : `Ses ${i + 1}`),
      active: t.enabled,
    }));
  }
  return [];
}

function selectAudioTrack(id) {
  if (window.masaustuSes) return window.masaustuSes.sec(id);
  if (hls?.audioTracks?.length > 1) {
    hls.audioTrack = Number(id);
    return;
  }
  if (video.audioTracks) {
    for (const t of video.audioTracks) t.enabled = String(t.id) === String(id);
  }
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

// Compatibility mode: Stremio's HLS converter, told which codecs this browser
// decodes so it only converts what is needed (often just the audio), and how
// wide the picture may be. 2K/4K conversion runs on whoever's Stremio converts:
// allowed on your own PC by your choice, on the host PC only with its permission.
const COMPAT_TIERS = Object.keys(COMPAT_WIDTHS);
let compatTier = COMPAT_TIERS.includes(storage.get('compatTier')) ? storage.get('compatTier') : '2160p';
let compat4k = false;
let lastCompatCaps = null;
let reencodeAllowed = false; // viewer chose "convert anyway" for the current stream
function capsFor(onHostPc) {
  const caps = browserCodecs(video);
  // Keeping quality: list every copyable video codec so Stremio never re-encodes the picture.
  if (keepQuality && !reencodeAllowed) caps.videoCodecs = [...HLS_VIDEO_CODECS];
  const wants4k = compatTier === '2160p';
  const allowed4k = wants4k && (!onHostPc || isHost() || state.room.settings.relay4k);
  if (allowed4k) caps.maxWidth = HLS_4K_WIDTH;
  else if (!wants4k) caps.maxWidth = COMPAT_WIDTHS[compatTier];
  // else: wanted 2K but no permission here -> leave unset, Stremio's own ~1920 cap applies
  compat4k = caps.maxWidth === HLS_4K_WIDTH;
  lastCompatCaps = caps;
  return caps;
}

async function compatSource(stream) {
  // Chromium on Windows reports canPlayType('...mpegurl') as 'maybe' despite not
  // actually being able to play an HLS playlist via <video src>, so gate on real
  // Safari first — otherwise this misroutes into a dead <video src> with no hls.js
  // and the alternate audio tracks (and the picture itself) never show up.
  const nativeHls = isRealSafari() && video.canPlayType('application/vnd.apple.mpegurl') !== '';
  if (stream.kind === 'http') {
    // Only the viewer's own Stremio can convert a plain link, and only for native HLS players.
    if (nativeHls && (await isStremioUp())) {
      return { url: `${STREMIO_BASE}${hlsV2Path(stream, capsFor(false))}`, source: 'http', hls: true, native: true };
    }
    return null;
  }
  // Native HLS needs no CORS, so guests can use their own Stremio.
  if (!isHost() && nativeHls && (await isStremioUp())) {
    return { url: `${STREMIO_BASE}${hlsV2Path(stream, capsFor(false))}`, source: 'local', hls: true, native: true };
  }
  // The host's "relay" is its own Stremio, so it only helps when that is running.
  if (isHost() && !(await isStremioUp())) return null;
  const key = await ensureRelay();
  if (!key || (!isHost() && !(await relayAlive(key)))) return null;
  const source = isHost() ? 'local' : 'relay';
  const url = `/relay/${roomId}/${key}${hlsV2Path(stream, capsFor(true))}`;
  if (nativeHls) return { url, source, hls: true, native: true };
  await loadHls().catch(() => {});
  return window.Hls?.isSupported() ? { url, source, hls: true } : null;
}

// Misafirin kendi Stremio'su yoksa relay'e kendiliğinden geçmiyoruz: önce "Stremio açık
// değil" uyarısı çıkıyor (Stremio'ya bağlan / Host üzerinden izle). Relay host'un
// internetini kullandığı için kişinin onayıyla. "Hep host üzerinden" seçilirse bir daha sormuyor.
// Misafir kendi Stremio'sundan 25 sn'dir yükleniyor/donuyorsa (bkz. renderNotice) relay önerilir.
let localWaitSince = null;
let localWaitDismissed = null;
function slowLocal() {
  return Boolean(localWaitSince && Date.now() - localWaitSince > 25_000 && localWaitDismissed !== myStreamId()
    && !isHost() && state.room?.settings.relayEnabled && myStream()?.kind === 'torrent');
}
// Kendiliğinden yeniden deneme: video 20 sn'dir "yükleniyor"da kaldıysa ya da hata verdiyse
// (çoğu zaman Stremio torrent'i ilk açarken geç cevap veriyor; elle "Tekrar dene" hemen
// açıyordu) aynı kaynak sessizce yeniden yüklenir. Kaynak başına en fazla 2 kez.
let loadingSince = null;
const autoRetries = new Map();
function autoRetry(reason) {
  const id = myStreamId();
  const n = autoRetries.get(id) || 0;
  if (!id || n >= 2) return false;
  autoRetries.set(id, n + 1);
  loadingSince = null;
  console.info('Kendiliğinden yeniden deneniyor', reason, n + 1);
  loadMyStream(true);
  return true;
}
setInterval(() => {
  const st = player.status();
  loadingSince = st.state === 'loading' ? (loadingSince || Date.now()) : null;
  if (loadingSince && Date.now() - loadingSince > 20_000) autoRetry('loading');
  const waiting = st.source === 'local' && ['loading', 'buffering'].includes(st.state);
  const was = slowLocal();
  localWaitSince = waiting ? (localWaitSince || Date.now()) : null;
  if (was !== slowLocal()) renderNotice();
}, 2000);

function relayApproved() {
  return state.relayApproved || storage.get('hepRelay') === '1';
}

async function resolveFallback(stream, opts) {
  if (opts.compat) return compatSource(stream);
  if (stream.kind !== 'torrent' || isHost()) return null;
  if (!relayApproved()) return null;
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
    else if (st.state === 'error' && autoRetry(player.lastError())) return;
    sendStatus();
    renderNotice();
    renderControls();
    renderRelayBadge();
  },
});

// "Keep picture quality": never let Stremio re-encode the picture. Compat
// mode then only repackages the file and converts audio.
let keepQuality = storage.get('keepQuality') !== '0';
let qualityBlocked = false; // the picture would need re-encoding and keepQuality forbids it
let hw = null; // hardware acceleration check result (see checkHardware below)

const RISK_CODEC = { HEVC: 'hevc', 'Dolby Vision': 'hevc', AV1: 'av1' };
function videoNeedsReencode(s) {
  const codec = RISK_CODEC[s?.videoRisk];
  return Boolean(codec) && !browserCodecs(video).videoCodecs.includes(codec);
}

// Detecting a silently-missing audio track live only works on Safari/Firefox
// (Chrome has no equivalent API), so known-risky audio codecs are checked
// up front from the release name instead and routed straight into compat mode.
const AUDIO_RISK_CODEC = { AC3: 'ac3', 'E-AC3': 'eac3', DTS: 'dts', 'DTS-HD': 'dts', TrueHD: 'truehd' };
function audioNeedsReencode(s) {
  const codec = AUDIO_RISK_CODEC[s?.audioRisk];
  return Boolean(codec) && !browserCodecs(video).audioCodecs.includes(codec);
}

let loaded = { streamId: undefined, compat: false };
function loadMyStream(force = false) {
  const s = myStream();
  const id = s?.streamId ?? null;
  if (!force && id === loaded.streamId) return;
  // Masaüstü kabuğunda dönüştürmeye hiç gerek yok: HEVC, Dolby Vision, AC3 - hepsini
  // mpv doğrudan açıyor. Uyumlu mod açılırsa HDR dosyalar boşuna bozuluyor ya da hiç açılmıyor.
  const masaustu = Boolean(window.masaustuSes);
  const compat = !masaustu && (Boolean(s?.notWebReady) || audioNeedsReencode(s)) && !(keepQuality && videoNeedsReencode(s));
  loaded = { streamId: id, compat };
  mediaProblem = null;
  reencodeAllowed = false;
  // Known undecodable picture in quality mode: ask before downloading anything.
  qualityBlocked = !masaustu && Boolean(s) && keepQuality && videoNeedsReencode(s);
  // "Host üzerinden izle" seçildiyse kendi Stremio'su açık olsa bile host'tan (relay) gelsin.
  player.load(qualityBlocked ? null : s, compat ? { forceFallback: true, compat: true } : state.forceRelay ? { forceFallback: true } : {});
  renderCompatButton();
  renderCompatTier();
  renderNotice();
  applyPic();
}

function startCompat({ allowReencode = false } = {}) {
  const s = myStream();
  if (!s || loaded.compat) return;
  if (allowReencode) reencodeAllowed = true;
  // Known undecodable picture: converting would cost quality, so ask first.
  if (keepQuality && !reencodeAllowed && videoNeedsReencode(s)) {
    qualityBlocked = true;
    renderNotice();
    subs?.rerender();
    return;
  }
  loaded.compat = true;
  mediaProblem = null;
  qualityBlocked = false;
  player.load(s, { forceFallback: true, compat: true });
  renderCompatButton();
  renderCompatTier();
  renderNotice();
  subs?.rerender();
}

function stopCompat() {
  const s = myStream();
  if (!s || !loaded.compat) return;
  loaded.compat = false;
  mediaProblem = null;
  toast('Normal moda dönülüyor…');
  player.load(s, {});
  renderCompatButton();
  renderCompatTier();
  subs?.rerender();
}

// Codec problems often fail silently: unsupported audio (AC3/DTS) plays
// picture without sound, unsupported video (HEVC) plays sound without picture.
let mediaProblem = null; // 'audio' | 'video' | null
function detectMediaProblem() {
  // Masaüstü (mpv) ve telefon (ExoPlayer) kabuğunda bu tahmine gerek yok: çözücü ilk
  // kareyi hazırlarken genişlik bir süre 0 kalıyor ve HEVC "açılamıyor" sanılıyordu.
  // Gerçekten açamazlarsa oynatıcı 'error' olayı yolluyor.
  if (window.masaustuSes) return;
  if (!player.stream() || video.readyState < 1) return;
  if (loaded.compat) {
    // Copied picture the browser still cannot decode (quality mode): ask the viewer.
    if (keepQuality && !reencodeAllowed && video.videoWidth === 0 && !qualityBlocked) {
      qualityBlocked = true;
      renderNotice();
    }
    return;
  }
  let problem = null;
  // Picture: known as soon as metadata is in, even while paused.
  if (video.videoWidth === 0) problem = 'video';
  // Sound: only measurable after a few seconds of real playback.
  else if (!video.paused && video.readyState >= 3 && video.currentTime >= 3) {
    if ('webkitAudioDecodedByteCount' in video) {
      if (video.webkitAudioDecodedByteCount === 0 && video.webkitVideoDecodedByteCount > 0) problem = 'audio';
    } else if ('mozHasAudio' in video && !video.mozHasAudio) problem = 'audio';
  } else return;
  if (problem === mediaProblem) return;
  mediaProblem = problem;
  if (problem === 'video' && keepQuality) {
    // The decoder cannot show this picture; only re-encoding would, which costs quality.
    qualityBlocked = true;
    renderNotice();
    return;
  }
  if (problem) {
    // Stremio converts only the part the browser cannot play, so switching is cheap.
    toast(problem === 'video'
      ? 'Görüntü gelmiyor (tarayıcı bu video biçimini açamıyor). Uyumlu moda geçiliyor…'
      : 'Ses gelmiyor (tarayıcı bu ses biçimini açamıyor). Uyumlu moda geçiliyor…', 6000);
    startCompat();
    return;
  }
  renderCompatButton();
}
setInterval(detectMediaProblem, 2000);
video.addEventListener('loadedmetadata', () => setTimeout(detectMediaProblem, 500));

// In compat mode Stremio re-encodes the picture only when its codec is not in
// the list we sent; that (and 4K -> 1080p downscaling) costs quality.
function compatQuality() {
  const s = myStream();
  if (!loaded.compat || !s) return null;
  const codec = RISK_CODEC[s.videoRisk];
  const reencoded = Boolean(codec) && !(lastCompatCaps?.videoCodecs || []).includes(codec);
  const is4k = s.quality === '2160p';
  const downscaled = is4k && video.videoHeight > 0 && video.videoHeight <= 1100;
  if (!reencoded && !downscaled) return { reencoded: false, text: null };
  const down = is4k && (downscaled || !compat4k);
  return {
    reencoded: true,
    text: `ℹ️ Uyumlu mod: görüntü dönüştürülüyor${down ? ` (4K → ${compat4k ? '4K' : compatTier})` : ''}, kalite biraz düşük. `
      + (down ? 'Kalite sekmesinden çözünürlüğü değiştirebilir ya da ' : 'Daha iyi görüntü için ')
      + '⚠️ işaretsiz (x264) bir dosya seçebilirsin.',
  };
}

// No floating pill and no auto-toast for this any more (only the control-bar
// button reflects state) — kept quiet on purpose, see compatQuality() callers.
function renderCompatButton() {
  const inline = $('#btn-compat');
  inline.classList.toggle('active', loaded.compat);
  inline.classList.toggle('warn', !loaded.compat && Boolean(mediaProblem));
  inline.title = loaded.compat
    ? 'Uyumlu mod açık · normale dönmek için tıkla'
    : mediaProblem
      ? 'Ses ya da görüntüde sorun olabilir — uyumlu modu dene'
      : 'Uyumlu moda geç (ses dili, düşük çözünürlük...)';
}

// ---- live download + viewers overlay on the player ----
const downloadMeter = createDownloadMeter(video, () => requiredMbps(myStream()?.sizeBytes, player.duration()));

function liveDownload() {
  const r = downloadMeter.read();
  // Masaüstünde mpv'nin ölçtüğü gerçek hız (önbellek dolunca okuma yavaşlar, o zaman tahmin).
  const net = window.masaustuHiz?.();
  const mbps = Number.isFinite(net) && net > 0.05 ? net : r.mbps;
  return {
    downMbps: mbps === null ? null : Math.round(mbps * 10) / 10,
    ahead: Math.round(r.ahead),
    complete: r.complete,
  };
}

const STATE_ICON = { ready: '▶', loading: '⏳', buffering: '⏳', error: '⚠️', noStremio: '🚫', idle: '💤' };
// Torrent stats are only readable for torrents running on the host PC:
// the host's own and those of viewers watching through the relay.
function hostPcStats(u, status = u.status) {
  const onHostPc = status.source === 'relay' || (u.id === state.room.hostUserId && status.source === 'local');
  if (!onHostPc) return null;
  return state.room.torrentStats?.[u.ownStreamId || state.room.hostStreamId] || null;
}

function speedLabel(st, ts = null, relayMbps = null) {
  if (st.source === 'none' || st.state === 'noStremio' || st.state === 'idle') return '';
  const parts = [];
  if (st.complete) parts.push('tamamı indi');
  else {
    // Relay'de kişinin gerçekten aldığı hız (host'tan giden), yoksa kendi ölçümü ya da torrent hızı.
    const down = Number.isFinite(relayMbps) && st.source === 'relay' ? relayMbps : Number.isFinite(st.downMbps) ? st.downMbps : ts?.downMbps;
    if (Number.isFinite(down)) parts.push(`↓ ${formatMbps(down)} Mbps`);
  }
  if (ts) parts.push(`🧲 ${ts.peers}`);
  if (!st.complete && Number.isFinite(st.ahead)) parts.push(`${st.ahead} sn`);
  return parts.join(' · ');
}

// What is actually on screen: resolution, codec path, file bitrate, dropped frames.
function resolutionLabel(h) {
  if (h >= 2000) return '2160p (4K)';
  if (h >= 1400) return '1440p';
  if (h >= 1000) return '1080p';
  if (h >= 700) return '720p';
  return `${h}p`;
}

function renderPictureInfo() {
  const box = $('#picture-info');
  const s = myStream();
  const h = video.videoHeight;
  if (!s) {
    box.hidden = true;
    return;
  }
  // Second line: torrent sources and file size (from the addon's listing).
  const extra = [];
  if (Number.isFinite(s.seeders)) extra.push(`👤 ${s.seeders} kaynak`);
  if (s.sizeBytes) extra.push(`💾 ${formatSize(s.sizeBytes)}`);
  const ts = state.room?.torrentStats?.[s.streamId];
  const hostPc = ts && (isHost() || player.status().source === 'relay');
  if (hostPc) extra.push(`🧲 ${ts.peers} bağlı`);
  // Live download: real torrent speed on the host PC, the browser's estimate otherwise.
  const down = hostPc ? ts.downMbps : liveDownload().downMbps;
  if (Number.isFinite(down)) extra.push(`↓ ${formatMbps(down)} Mbps şu an`);
  const need = requiredMbps(s.sizeBytes, player.duration());
  if (need) extra.push(`gereken ~${formatMbps(need)} Mbps`);
  if (s.hdr) extra.push(`🌗 ${s.hdr}`);
  // Masaüstünde önündeki hazır veri: azalıyorsa takılma ağdan, çoksa çözmeden.
  if (window.masaustuOnbellek) extra.push(`⏩ ${Math.round(window.masaustuOnbellek())} sn hazır`);
  const extraLine = extra.length ? el('div', { text: extra.join(' · ') }) : null;
  if (!h) {
    box.replaceChildren(...[extraLine].filter(Boolean));
    box.hidden = !extraLine;
    return;
  }
  const parts = [];
  const res = resolutionLabel(h);
  const fileRes = s.quality === '2160p' ? '2160p (4K)' : s.quality;
  const srcCodec = s.videoRisk || null;
  const reencoded = loaded.compat && compatQuality()?.reencoded;
  if (reencoded) {
    // Converted: show both ends, e.g. "2160p (4K) HEVC → 1080p H.264".
    parts.push(el('b', { text: `🎞 ${fileRes || '?'}${srcCodec ? ` ${srcCodec}` : ''} → ${res} H.264` }));
    parts.push('uyumlu mod, dönüştürülüyor');
  } else {
    parts.push(el('b', { text: `🎞 ${res}${srcCodec ? ` ${srcCodec}` : ''}` }));
    if (fileRes && fileRes !== res) parts.push(`dosya ${fileRes}`);
    if (loaded.compat) parts.push('uyumlu mod, orijinal görüntü');
  }
  const q = video.getVideoPlaybackQuality?.();
  if (q && q.totalVideoFrames > 100) {
    const lost = (q.droppedVideoFrames / q.totalVideoFrames) * 100;
    if (lost >= 1) parts.push(`%${Math.round(lost)} kare kaybı`);
  }
  box.replaceChildren(el('div', {}, ...parts.flatMap((p, i) => (i ? [' · ', p] : [p]))), extraLine);
  box.hidden = false;
}
video.addEventListener('resize', renderPictureInfo);
video.addEventListener('emptied', renderPictureInfo);

function renderViewersOverlay() {
  renderPictureInfo();
  if (!state.room) return;
  const users = state.room.users.filter((u) => u.connected);
  const mine = { ...player.status(), ...liveDownload() };
  $('#viewers-count').textContent = String(users.length);
  $('#viewers-list').replaceChildren(...users.map((u) => {
    const st = u.id === state.me ? { ...u.status, ...mine } : u.status;
    const ts = hostPcStats(u, st);
    return el('li', { title: ts ? '🧲 bağlı peer sayısı (host bilgisayarındaki Stremio)' : '' },
      el('span', { text: STATE_ICON[st.state] || '•' }),
      el('span', { class: 'n', text: `${u.name}${u.isHost ? ' 👑' : ''}${u.id === state.me ? ' (sen)' : ''}` }),
      el('span', { class: 'sp', text: speedLabel(st, ts, state.relayStats?.[u.id]) }));
  }));
}
setInterval(renderViewersOverlay, 2000);

function sendStatus() {
  if (!state.room || state.ended || !socket.connected) return;
  const st = player.status();
  request('status', {
    state: st.state,
    source: st.source,
    drift: sync.drift(),
    duration: player.duration(),
    quality: myStream()?.quality ?? null,
    error: st.state === 'error' ? player.lastError() : null,
    ...liveDownload(),
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
  embeddedInfo: () => (myStream()?.embeddedSubs ? embeddedSubsText(myStream()) : null),
  embeddedLangs: () => myStream()?.embeddedSubs?.langs || [],
  audioTracks: audioTracksList,
  onSelectAudio: selectAudioTrack,
  multiAudioLikely: () => Boolean(myStream()?.multiAudio),
  compatActive: () => loaded.compat || desktopApp(),
  onSwitchCompat: () => startCompat(),
  reencodeBlocked: () => qualityBlocked && Boolean(myStream()?.multiAudio),
  onForceCompat: () => startCompat({ allowReencode: true }),
  streamKey: () => myStreamId(),
});

// Video host üzerinden (relay) geliyorsa başlığın yanında rozet; kendi Stremio'su olabilecek
// (dokunmatik olmayan) cihazlarda bir de "Stremio'ya bağlan" düğmesi.
function renderRelayBadge() {
  const relay = player.status().source === 'relay';
  $('#relay-badge').hidden = !relay;
  $('#connect-stremio').hidden = !relay || isHost() || isTouch;
}

// Stremio'yu aç, açılınca oynatıcıyı yeniden kur: kaynak seçimi kendi Stremio'yu relay'e tercih ediyor.
let stremioWatch = null;
function connectStremio() {
  launchStremio();
  clearInterval(stremioWatch);
  const started = Date.now();
  stremioWatch = setInterval(async () => {
    if (Date.now() - started > 60_000) return clearInterval(stremioWatch);
    if (!(await isStremioUp())) return;
    clearInterval(stremioWatch);
    toast("Stremio'ya bağlanıldı, video artık kendi Stremio'ndan geliyor.", 5000);
    player.reload();
  }, 2000);
}
$('#connect-stremio').addEventListener('click', connectStremio);
// Relay rozetine basınca da Stremio'ya bağlanmayı dene.
$('#relay-badge').addEventListener('click', connectStremio);

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
    statsFor: (u) => hostPcStats(u),
    relayFor: (u) => state.relayStats?.[u.id] ?? null,
    onKick: async (u) => {
      if (!confirm(`${u.name} odadan çıkarılsın mı? Tekrar giremez.`)) return;
      const res = await request('kick', { userId: u.id });
      if (res?.error) toast(errorText(res.error));
    },
  });
  $('#user-count').textContent = String(count);
}

let mismatchWarned = false;

// All streams are the same title, so one duration (ours or the host's) fits all.
function contentDuration() {
  const own = player.duration();
  if (own) return own;
  const host = state.room?.users.find((u) => u.id === state.room.hostUserId);
  return Number.isFinite(host?.status?.duration) ? host.status.duration : null;
}

// Whether this browser shows a stream's picture in original quality.
function embeddedSubsText(s) {
  const langs = s.embeddedSubs?.langs || [];
  return `Dosyanın içinde gömülü altyazı var${langs.length ? `: ${langs.join(', ')}` : ''} (dosya adına göre). `
    + 'Tarayıcı gömülü altyazıyı gösteremez; Altyazı sekmesinden aynı dilde bir altyazı seç.';
}

// Icons for the quality list; the explanation sits behind an ⓘ.
// Kalite adındaki ses türü -> telefonun bildirdiği çözücü anahtarı (OdaActivity.cihazBilgisi).
const PHONE_AUDIO_KEY = { AC3: 'ac3', 'E-AC3': 'eac3', DTS: 'dts', 'DTS-HD': 'dts', TrueHD: 'truehd' };
function pictureVerdict(s) {
  // Uygulamalarda (masaüstü mpv, telefon ExoPlayer) her görüntü ve ses biçimi açılıyor:
  // "açılır mı" simgeleri gereksiz ve ses için yanıltıcıydı; yalnızca HDR bilgisi kalıyor.
  const shell = Boolean(window.masaustuSes);
  const items = [];
  if (!shell) {
    const v = pictureVerdictBase(s);
    items.push({ icon: v.ok ? '✅' : '⚠️', text: v.text.replace(/^(✅|⚠️)\s*/, '') });
  }
  if (s.hdr) items.push({ icon: '🌗', text: `${s.hdr}: HDR olmayan ekranda karanlık ya da soluk görünebilir (parlaklık ayarı yukarıda).` });
  if (s.pack) items.push({ icon: '📦', text: 'Sezon paketi: izleyenler dağınık, kaynak çabuk azalabilir. Aynı kalitede tek bölümlük torrent genelde daha hızlı.' });
  if (s.embeddedSubs) {
    const langs = s.embeddedSubs.langs || [];
    items.push({ icon: '💬', text: shell
      ? `Dosyanın içinde gömülü altyazı var${langs.length ? `: ${langs.join(', ')}` : ''}. Altyazı sekmesinden seçebilirsin.`
      : embeddedSubsText(s) });
  }
  // Telefon uygulaması: telefonun bu sesi çözecek donanımı yoksa uyar (ses dönüştürülerek açılır).
  const phoneAudio = window.mobilCihaz?.ses;
  const riskMime = PHONE_AUDIO_KEY[s.audioRisk];
  if (s.audioRisk && phoneAudio && riskMime && phoneAudio[riskMime] === false) {
    items.push({ icon: '🔇', text: `${s.audioRisk}: bu telefon bu sesi çözemiyor. Açılınca ses otomatik dönüştürülür (Uyumlu mod), görüntü aynı kalır; başlaması biraz gecikebilir.` });
  }
  if (s.audioRisk && !shell) {
    items.push(audioNeedsReencode(s)
      ? { icon: '🔇', text: `${s.audioRisk}: tarayıcın bu sesi açamıyor, otomatik Uyumlu moda geçilir (sadece ses dönüştürülür).` }
      : { icon: '🔊', text: `${s.audioRisk}: tarayıcın açabiliyor, orijinal kalite` });
  }
  return items;
}

function pictureVerdictBase(s) {
  if (!s.videoRisk) return { ok: true, text: '✅ orijinal kalitede oynar' };
  const supported = !videoNeedsReencode(s);
  if (s.videoRisk === 'Dolby Vision') {
    return supported
      ? { ok: true, text: '✅ Dolby Vision: açılır (bazı dosyalarda renkler bozuk olabilir)' }
      : { ok: false, text: '⚠️ Dolby Vision: tarayıcın açamıyor' };
  }
  return supported
    ? { ok: true, text: `✅ ${s.videoRisk}: tarayıcın açabiliyor, orijinal kalite` }
    : { ok: false, text: `⚠️ ${s.videoRisk}: tarayıcın açamıyor${keepQuality ? '' : ' (dönüştürülür, kalite düşer)'}` };
}

// Host-only: test a torrent's real peers/download speed before picking it,
// without switching the room to it. A longer socket timeout than the usual
// 8s request() default since the server side actively waits on Stremio.
const streamChecks = new Map(); // streamId -> { checking, result }
function checkStream(streamId) {
  streamChecks.set(streamId, { checking: true, result: null });
  renderQualityTab();
  return new Promise((resolve) => {
    socket.timeout(26_000).emit('checkStream', { streamId }, (err, res) => {
      if (err) res = { error: 'timeout' };
      streamChecks.set(streamId, { checking: false, result: res?.error ? null : res });
      if (res?.error) toast(errorText(res.error));
      renderQualityTab();
      resolve();
    });
  });
}

// Host-only: re-asks the configured addons for streams (one may have timed
// out, or been added to the panel after the room opened) and merges in
// anything new — doesn't touch what's currently playing.
let refreshingAddons = false;
async function refreshAddonStreams() {
  if (refreshingAddons) return;
  refreshingAddons = true;
  const btn = $('#quality-refresh-addons');
  btn.disabled = true;
  btn.textContent = '🔄 Aranıyor…';
  const res = await request('refreshStreams');
  refreshingAddons = false;
  btn.disabled = false;
  btn.textContent = "🔄 Addon'ları tekrar ara";
  if (res?.error) return toast(errorText(res.error));
  toast(
    res.added
      ? `${res.added} yeni stream bulundu.`
      : 'Yeni stream bulunamadı.',
  );
  if (res.errors?.length) toast(`Cevap vermeyen addon'lar: ${res.errors.join(', ')}`, 6000);
}
$('#quality-refresh-addons').addEventListener('click', refreshAddonStreams);

// Stremio takılıp hiçbir torrent için hız vermediğinde elle kapatıp açmak yerine.
$('#restart-stremio').addEventListener('click', async () => {
  const btn = $('#restart-stremio');
  btn.disabled = true;
  const res = await request('restartStremio');
  if (res?.error) toast(errorText(res.error));
  setTimeout(() => { btn.disabled = false; }, 15_000);
});

$('#boost-peers').addEventListener('click', async () => {
  const btn = $('#boost-peers');
  btn.disabled = true;
  const res = await request('boostPeers');
  if (res?.error) toast(errorText(res.error));
  setTimeout(() => { btn.disabled = false; }, 30_000);
});

$('#quality-filter-btn').addEventListener('click', () => {
  $('#quality-filter-panel').hidden = !$('#quality-filter-panel').hidden;
});
const HDR_CYCLE = { all: ['hdr', 'Görüntü: Tümü'], hdr: ['sdr', 'Görüntü: HDR'], sdr: ['all', 'Görüntü: SDR'] };
$('#filter-hdr-cycle').addEventListener('click', () => {
  qualityFilters.hdrMode = HDR_CYCLE[qualityFilters.hdrMode][0];
  renderQualityTab();
});
$('#filter-size').addEventListener('change', (e) => {
  qualityFilters.maxGb = e.target.value ? Number(e.target.value) : null;
  renderQualityTab();
});
$('#filter-speed').addEventListener('change', (e) => {
  qualityFilters.maxMbps = e.target.value ? Number(e.target.value) : null;
  renderQualityTab();
});
$('#filter-clear').addEventListener('click', () => {
  qualityFilters.res.clear();
  qualityFilters.hdrMode = 'all';
  qualityFilters.maxGb = null;
  qualityFilters.maxMbps = null;
  $('#filter-size').value = '';
  $('#filter-speed').value = '';
  renderQualityTab();
});

// Tests every torrent in the currently-open addon tab, 10 at a time. Clicking
// the same button again while it runs stops it from starting any more (checks
// already in flight still finish on their own — there's no way to abort those).
let checkingAll = false;
let cancelAllRequested = false;
function stopCheckAll() {
  if (!checkingAll) return;
  cancelAllRequested = true;
  renderQualityTab();
}
async function checkAllInTab(streams) {
  if (checkingAll) return;
  checkingAll = true;
  cancelAllRequested = false;
  renderQualityTab();
  const queue = streams.filter((s) => s.kind === 'torrent' && !streamChecks.get(s.streamId)?.checking);
  const CONCURRENCY = 10;
  let next = 0;
  async function worker() {
    while (next < queue.length && !cancelAllRequested) {
      const s = queue[next++];
      await checkStream(s.streamId);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  checkingAll = false;
  cancelAllRequested = false;
  renderQualityTab();
}

let qualityAddonFilter = 'all';
function renderQualityAddonTabs() {
  const box = $('#quality-addon-tabs');
  const names = [...new Set(state.room.streams.map((s) => s.addonName).filter(Boolean))];
  if (names.length <= 1) {
    box.hidden = true;
    qualityAddonFilter = 'all';
    return;
  }
  if (qualityAddonFilter !== 'all' && !names.includes(qualityAddonFilter)) qualityAddonFilter = 'all';
  box.hidden = false;
  const tab = (key, label, count) => {
    const b = el('button', { type: 'button', class: qualityAddonFilter === key ? 'active' : '', text: `${label} (${count})` });
    b.addEventListener('click', () => { qualityAddonFilter = key; renderQualityTab(); });
    return b;
  };
  box.replaceChildren(
    tab('all', 'Tümü', state.room.streams.length),
    ...names.map((name) => tab(name, name, state.room.streams.filter((s) => s.addonName === name).length)),
  );
}

// Resolution / HDR-SDR / size / needed-speed filters, layered on top of the addon tab.
const qualityFilters = { res: new Set(), hdrMode: 'all', maxGb: null, maxMbps: null };
// Telefon uygulamasında: yalnızca bu telefonun çözebildiği kaynaklar (kişisel tercih,
// varsayılan kapalı). window.mobilCihaz telefonun çözücü sınırlarını taşıyor.
const deviceCaps = window.mobilCihaz || null;
let deviceFilter = Boolean(deviceCaps) && storage.get('cihazaUygun') === '1';
function fitsDevice(s) {
  const height = Number.parseInt(s.quality, 10);
  if (!deviceCaps || !Number.isFinite(height)) return true;
  const codec = s.videoRisk === 'AV1' ? 'av1' : s.videoRisk ? 'hevc' : 'h264';
  const max = deviceCaps[codec] || 0;
  // Biraz pay: 2160p'yi "2176" diye bildiren çözücüler var.
  return max > 0 && height <= max + 32;
}
function filtersActive() {
  return Boolean(qualityFilters.res.size || qualityFilters.hdrMode !== 'all' || qualityFilters.maxGb !== null || qualityFilters.maxMbps !== null || deviceFilter);
}
function matchesQualityFilters(s) {
  if (deviceFilter && !fitsDevice(s)) return false;
  if (qualityFilters.res.size && !qualityFilters.res.has(s.quality || '?')) return false;
  if (qualityFilters.hdrMode === 'hdr' && !s.hdr) return false;
  if (qualityFilters.hdrMode === 'sdr' && s.hdr) return false;
  if (qualityFilters.maxGb !== null) {
    const gb = s.sizeBytes ? s.sizeBytes / 1024 ** 3 : null;
    if (gb === null || gb >= qualityFilters.maxGb) return false;
  }
  if (qualityFilters.maxMbps !== null) {
    const need = requiredMbps(s.sizeBytes, contentDuration());
    if (need === null || need >= qualityFilters.maxMbps) return false;
  }
  return true;
}
if (deviceCaps) {
  $('#filter-device-wrap').hidden = false;
  $('#filter-device').checked = deviceFilter;
  $('#filter-device').addEventListener('change', (e) => {
    deviceFilter = e.target.checked;
    storage.set('cihazaUygun', deviceFilter ? '1' : '0');
    renderQualityTab();
  });
}
// Kalite sırası: en yüksek çözünürlük en üstte (4K/2160p), aynı kalitede çok kaynaklı önce.
const QUALITY_RANK = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p'];
// Kişinin tercih ettiği kalite (ilk girişte soruluyor, Ayarlar'dan değişiyor) hep en üstte.
// Uygulamada açılış ekranında seçilen kalite (masaüstü: window.kabuk, telefon: mobilCihaz) önce gelir.
const appQuality = () => window.kabuk?.kalite?.() || window.mobilCihaz?.kalite || null;
let preferredQuality = [appQuality(), storage.get('tercihKalite')].find((q) => ['2160p', '1080p', '720p'].includes(q)) || null;
const qualityRank = (q) => {
  if (preferredQuality && q === preferredQuality) return -1;
  const i = QUALITY_RANK.indexOf(q);
  return i < 0 ? QUALITY_RANK.length : i;
};
const byQualityThenSeeders = (a, b) => qualityRank(a.quality) - qualityRank(b.quality) || (Number(b.seeders) || 0) - (Number(a.seeders) || 0);

function renderQualityResFilter(streams) {
  const box = $('#quality-res-filter');
  const qualities = [...new Set(streams.map((s) => s.quality).filter(Boolean))].sort((a, b) => qualityRank(a) - qualityRank(b));
  for (const q of [...qualityFilters.res]) if (!qualities.includes(q)) qualityFilters.res.delete(q);
  if (!qualities.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.replaceChildren(...qualities.map((q) => {
    const b = el('button', { type: 'button', class: qualityFilters.res.has(q) ? 'active' : '', text: q });
    b.addEventListener('click', () => {
      if (qualityFilters.res.has(q)) qualityFilters.res.delete(q);
      else qualityFilters.res.add(q);
      renderQualityTab();
    });
    return b;
  }));
}

function renderQualityTab() {
  renderQualityAddonTabs();
  $('#quality-refresh-addons').hidden = !isHost();
  $('#restart-stremio').hidden = !isHost();
  $('#boost-peers').hidden = !isHost() || myStream()?.kind !== 'torrent';
  const addonStreams = qualityAddonFilter === 'all'
    ? state.room.streams
    : state.room.streams.filter((s) => s.addonName === qualityAddonFilter);
  renderQualityResFilter(addonStreams);
  const filterBtn = $('#quality-filter-btn');
  filterBtn.hidden = !addonStreams.length;
  if (!addonStreams.length) $('#quality-filter-panel').hidden = true;
  $('#filter-hdr-cycle').textContent = HDR_CYCLE[qualityFilters.hdrMode][1];
  $('#filter-clear').hidden = !filtersActive();
  const activeCount = (qualityFilters.res.size ? 1 : 0) + (qualityFilters.hdrMode !== 'all' ? 1 : 0)
    + (qualityFilters.maxGb !== null ? 1 : 0) + (qualityFilters.maxMbps !== null ? 1 : 0);
  $('#quality-filter-count').hidden = !activeCount;
  $('#quality-filter-count').textContent = String(activeCount);
  // "Tümünü test et" de bu sırayla gidiyor: önce 4K'ların en çok kaynaklıları.
  const streams = addonStreams.filter(matchesQualityFilters).sort(byQualityThenSeeders);
  const torrents = streams.filter((s) => s.kind === 'torrent');
  const checkAllBtn = $('#quality-check-all');
  checkAllBtn.hidden = !isHost() || !torrents.length;
  checkAllBtn.disabled = false;
  if (checkingAll) {
    const done = torrents.filter((s) => {
      const c = streamChecks.get(s.streamId);
      return c && !c.checking;
    }).length;
    checkAllBtn.textContent = cancelAllRequested
      ? `⏳ Durduruluyor… (${done}/${torrents.length})`
      : `⏹ Durdur (${done}/${torrents.length})`;
    checkAllBtn.onclick = stopCheckAll;
  } else {
    checkAllBtn.textContent = `🔍 ${qualityAddonFilter === 'all' ? 'Tümünü' : `${qualityAddonFilter} sekmesini`} test et (${torrents.length})`;
    checkAllBtn.onclick = () => checkAllInTab(torrents);
  }
  renderQuality($('#quality-list'), { ...state.room, streams }, {
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
      else playAfterSwitch();
    },
    needFor: (s) => requiredMbps(s.sizeBytes, contentDuration()),
    pictureFor: (s) => pictureVerdict(s),
    checkStatusFor: (s) => streamChecks.get(s.streamId) || null,
    onCheckStream: checkStream,
  });
  if (!streams.length && addonStreams.length) {
    $('#quality-list').replaceChildren(el('li', { class: 'muted', text: 'Bu filtrelere uyan stream yok.' }));
  }
  const host = state.room.users.find((u) => u.id === state.room.hostUserId);
  const mine = me();
  const mismatch = Boolean(mine && host && mine.id !== host.id && durationMismatch(mine, host));
  const box = $('#quality-warning');
  box.hidden = !mismatch;
  box.textContent = "⚠️ Bu sürümün süresi host'unkinden farklı, senkron kayabilir. Mümkünse host'la aynı stream'i seç.";
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

const HEVC_HELP = 'HEVC (x265) videoyu tarayıcıda açmak için:\n\n'
  + '• Edge: Microsoft Store\'dan "HEVC Video Uzantıları"nı kur, sonra Edge\'i tamamen kapatıp aç.\n'
  + '• Chrome: güncel sürümde, ekran kartın destekliyorsa kendiliğinden açar (çoğu 2016 sonrası ekran kartı).\n'
  + '• Ekran kartı sürücüsünün güncel olması gerekir.\n\n'
  + 'Sonra sayfayı yenile.';

// Stremio Desktop kurulurken "stremio://" protokolunu kaydeder; link tiklamasi uygulamayi
// acar (tarayici "Stremio'yu ac?" diye sorabilir). Acildiktan sonra player zaten 3 saniyede
// bir yeniden dener (bkz. player.js PROBE_RETRY_MS), ayrica baglanma islemine gerek yok.
function launchStremio() {
  const link = document.createElement('a');
  link.href = 'stremio://';
  document.body.appendChild(link);
  link.click();
  link.remove();
  toast("Stremio başlatılıyor… Açılınca otomatik bağlanacak. Tarayıcı izin sorarsa 'Aç'a bas.", 6000);
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
  } else if (qualityBlocked) {
    const s = myStream();
    const noGpu = hw && !hw.gpu;
    text = `Tarayıcın bu videonun görüntü biçimini${s?.videoRisk ? ` (${s.videoRisk})` : ''} açamıyor.\n`
      + (noGpu ? 'Tarayıcında donanım hızlandırma kapalı görünüyor; açınca bu dosya da açılabilir.\n' : '')
      + 'Kalite düşmesin diye görüntü dönüştürülmedi.\n'
      + 'Kalite sekmesinde ✅ işaretli bir dosyaya geçebilir ya da bir çözünürlükle yine de dönüştürebilirsin.';
    actions.push(button('✅ Dosya seç', () => selectTab('quality'), true));
    if (noGpu) actions.push(button('Donanım hızlandırma nasıl açılır?', () => alert(HW_HELP)));
    else actions.push(button('HEVC nasıl açılır?', () => alert(HEVC_HELP)));
    // Pick the resolution right here instead of a single "convert anyway" that
    // silently lands on whatever tier was last used — that's the point of asking.
    for (const [q, label] of [['2160p', '2K'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']]) {
      actions.push(button(`${label} ile dönüştür`, () => {
        qualityBlocked = false;
        loaded.compat = false;
        selectCompatTier(q);
      }));
    }
  } else if (slowLocal()) {
    // Kendi Stremio'su bu kaynağı indiremiyor (kaynak zayıf ya da internet yavaş): host'un
    // bilgisayarından (onun hızıyla) izlemeyi öner.
    text = "Kendi Stremio'n bu kaynağı yeterince hızlı indiremiyor, video bekliyor.\n"
      + "Host üzerinden izlersen video host'un bilgisayarından, onun hızıyla gelir.";
    actions.push(button('📶 Host üzerinden izle', () => {
      state.relayError = null;
      state.relayApproved = true;
      state.forceRelay = true;
      localWaitSince = null;
      loadMyStream(true);
    }, true));
    actions.push(button('Beklemeye devam', () => { localWaitDismissed = myStreamId(); renderNotice(); }));
  } else if (st.state === 'noStremio') {
    const relayNote = state.room?.settings.relayEnabled && !isHost()
      ? (isTouch ? '\nYoksa "Host üzerinden izle".' : '\n\nStremio\'n yoksa "Host üzerinden izle" ile host\'un bilgisayarından izleyebilirsin (host\'un internetini kullanır).')
      : '';
    text = (isTouch
      ? 'Stremio\'ya bağlanılamadı.'
      : 'Stremio açık değil.\nBilgisayarında Stremio varsa "Stremio\'ya bağlan"a bas, açılınca kendiliğinden bağlanır.\nTarayıcı "yerel ağdaki cihazlara erişim" izni sorarsa İzin ver\'e bas.') + relayNote;
    if (state.relayError && !isHost()) text += `\n\nHost üzerinden izleme: ${errorText(state.relayError)}`;
    actions.push(button("🔌 Stremio'ya bağlan", connectStremio, true));
    if (state.room?.settings.relayEnabled && !isHost()) {
      actions.push(button('📶 Host üzerinden izle', () => {
        state.relayError = null;
        state.relayApproved = true;
        player.reload();
      }, true));
      actions.push(button('📶 Bu cihazda hep host üzerinden izle', () => {
        storage.set('hepRelay', '1');
        state.relayError = null;
        state.relayApproved = true;
        player.reload();
      }));
    }
  } else if (st.state === 'error') {
    const reason = player.lastError();
    text = desktopApp() ? 'Video açılamadı.' : {
      unsupported: 'Tarayıcın bu videoyu açamıyor.',
      decode: 'Video çözülemedi.',
      network: 'Videoya ulaşılamadı.',
      timeout: 'Video 60 saniyedir başlamadı. Torrent\'te yeterli kaynak olmayabilir.',
      hls: 'Uyumlu mod da videoyu açamadı.',
      compat: 'Uyumlu mod bu cihazda kullanılamıyor.',
    }[reason] || 'Video açılamadı.';
    text += isHost() ? '\nKalite sekmesinden başka bir stream seçebilirsin.' : '\nKalite sekmesinden başka bir stream deneyebilirsin.';
    if (!loaded.compat && !desktopApp()) actions.push(button('🛠 Uyumlu modu dene', startCompat, true));
    actions.push(button('Tekrar dene', () => loadMyStream(true)));
    actions.push(button('Kalite', () => selectTab('quality')));
  }

  box.hidden = !text;
  $('#notice-text').textContent = text || '';
  $('#notice-actions').replaceChildren(...actions);
}

function renderControls() {
  const control = canControl();
  setIcon($('#btn-play'), sync.intendsToPlay() ? 'pause' : 'play');
  $('#btn-play').disabled = !control;
  $('#seek').disabled = !control;
  $('#lock-hint').hidden = control;
  renderCompatButton();
}

function updateHostUi() {
  $('#open-settings').hidden = false;
  $('#room-settings').hidden = !isHost();
  $('#tab-search').hidden = !isHost();
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
  const firstJoin = !state.joinedOnce; // reconnect'lerde applySnapshot tekrar cagrilir - otomatik tarama yalnizca ilk girişte calismali
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
  if (firstJoin) {
    maybeAutoCheckQuality();
    refreshCompat({ auto: true });
  }
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
  renderViewersOverlay();
  renderQualityTab();
  renderBanner();
  renderHeader();
  loadMyStream();
});

socket.on('chat', (m) => {
  chat.add(m);
  // Masaüstünde tam ekranda sohbet paneli görünmüyor: mesaj videonun köşesinde çıksın.
  if (document.fullscreenElement && !m.system) window.masaustuSohbet?.(m.from, m.text);
});

socket.on('hostStream', ({ hostStreamId, streams }) => {
  state.room.hostStreamId = hostStreamId;
  state.room.streams = streams;
  renderQualityTab();
  renderUsersTab();
  loadMyStream();
  refreshCompat();
});

socket.on('content', (d) => {
  state.room.type = d.type;
  state.room.contentId = d.contentId;
  state.room.meta = d.meta;
  state.room.hostStreamId = d.hostStreamId;
  state.room.streams = d.streams;
  mismatchWarned = false;
  renderHeader();
  renderQualityTab();
  renderUsersTab();
  loadMyStream(true);
  selectTab('quality');
  refreshCompat();
});

// Host üzerinden izleyenlere giden hız (host'un yüklemesi), kişi başı.
socket.on('relayStats', (rs) => {
  state.relayStats = Object.fromEntries((rs?.users || []).map((u) => [u.userId, u.mbps]));
  renderViewersOverlay();
  renderUsersTab();
});
socket.on('torrentStats', (stats) => {
  state.room.torrentStats = stats;
  renderViewersOverlay();
  renderUsersTab();
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
  const relay4kChanged = s.relay4k !== state.room.settings.relay4k;
  state.room.settings = s;
  updateHostUi();
  renderNotice();
  renderCompatTier();
  // A relay viewer's 2K/4K conversion depends on the host's permission.
  if (relay4kChanged && compatTier === '2160p' && player.status().source === 'relay') reloadCompatTier();
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

// Host Stremio'yu yeniden başlattı: onun Stremio'sundan gelen video (host'un kendisi ve relay
// ile izleyenler) kopmuş bağlantıda takılı kalmasın, aynı kaynağı yeniden aç. Konumu sync
// yüklenince odanın konumuna getiriyor.
socket.on('stremioRestarted', () => {
  if (!isHost() && player.status().source !== 'relay') return;
  loadMyStream(true);
});
socket.on('kicked', () => end('Odadan çıkarıldın.'));
socket.on('replaced', () => end('Bu oda başka bir sekmede açıldı.'));
socket.on('roomClosed', () => {
  end('Oda kapandı.');
  // Masaüstü/telefon uygulamasında kısa bir süre sonra açılış ekranına dön.
  setTimeout(() => window.masaustuOdaKapandi?.(), 2500);
});
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
  $('#time').textContent = formatTime(Number(seek.value));
  $('#dur').textContent = formatTime(video.duration);
  renderSeekBar();
});
// Çubuğun üstünde gezinince (telefonda sürüklerken) o anın dakikası/saniyesi ve küçük
// önizleme resmi. Önizleme ayrı, sessiz bir <video> ile o saniyeye atlayarak çiziliyor;
// torrentte o dakikanın parçası da indiriliyor, bu yüzden Ayarlar'dan kapatılabiliyor.
// Önizleme istekleri masaüstünde ara katmandan geçtiği için Stremio'da birikme yapmıyor.
let seekPreviewOn = storage.get('seekPreview2') !== '0';
const previewVideo = el('video', { class: 'seek-onizleme', muted: true, playsinline: true, preload: 'metadata', hidden: true });
previewVideo.muted = true;
const seekTipTime = el('span');
// Masaüstünde kareyi mpv çıkarıyor (tarayıcı HEVC/MKV açamıyor): resim olarak geliyor.
const previewImg = el('img', { class: 'seek-onizleme', alt: '', hidden: true });
const seekTip = el('div', { class: 'seek-tip', hidden: true }, previewVideo, previewImg, seekTipTime);
let imgWant = null;
let imgTimer = null;
// Sayfada da küçük önbellek: aynı kare için masaüstü köprüsüne hiç gidilmiyor.
const imgCache = new Map();
function previewImage(src, t, step) {
  if (imgWant === t) return;
  imgWant = t;
  clearTimeout(imgTimer);
  const hit = imgCache.get(`${src}|${t}`);
  if (hit) {
    previewImg.src = hit;
    previewImg.hidden = false;
    return;
  }
  imgTimer = setTimeout(async () => {
    const data = await window.masaustuOnizleme(src, t).catch(() => null);
    if (data) {
      imgCache.set(`${src}|${t}`, data);
      if (imgCache.size > 400) imgCache.delete(imgCache.keys().next().value);
    }
    if (imgWant !== t || seekTip.hidden) return;
    if (data) {
      previewImg.src = data;
      previewImg.hidden = false;
    }
    // İmleç duruyorsa iki yanındaki kareleri de hazırla (fare genelde yakına gidiyor).
    // Yeni bir istek gelirse masaüstü tarafı bunları atlıyor.
    for (const n of [t + step, t - step]) {
      if (n >= 0 && !imgCache.has(`${src}|${n}`)) {
        window.masaustuOnizleme(src, n).then((d) => { if (d) imgCache.set(`${src}|${n}`, d); }).catch(() => {});
      }
    }
  }, 80);
}
// Video açılınca önizleme dosyası önceden açılsın (ilk kare hızlı gelsin).
video.addEventListener('loadedmetadata', () => {
  const src = previewSource();
  if (src && window.masaustuOnizlemeHazirla) window.masaustuOnizlemeHazirla(src);
});
seek.parentElement.append(seekTip);
let previewFor = null;
let previewFailed = null;
let previewWant = null;
function previewSource() {
  if (!seekPreviewOn || loaded.compat) return null;
  // Relay'de önizleme host'un upload'unu yer; hls/blob kaynaklarda atlanamıyor.
  if (player.status().source === 'relay') return null;
  const url = streamLink();
  return url && /^https?:/.test(url) ? url : null;
}
function previewSeek() {
  if (previewWant === null || previewVideo.seeking || previewVideo.readyState < 1) return;
  if (Math.abs(previewVideo.currentTime - previewWant) < 1) return;
  previewVideo.currentTime = previewWant;
}
previewVideo.addEventListener('loadedmetadata', previewSeek);
previewVideo.addEventListener('seeked', () => {
  previewVideo.hidden = false;
  previewSeek();
});
previewVideo.addEventListener('error', () => {
  previewFailed = previewFor;
  previewVideo.hidden = true;
});
function showSeekTip(x, width) {
  const d = video.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  const t = (x / width) * d;
  seekTipTime.textContent = formatTime(t);
  // Kutu çubuğun kenarından taşmasın.
  const half = previewVideo.hidden && previewImg.hidden ? 30 : 90;
  seekTip.style.left = `${Math.max(half, Math.min(width - half, x))}px`;
  seekTip.hidden = false;
  const src = previewSource();
  // Kareler ızgaraya oturuyor (en az 5 sn, uzun videoda süre/300): yakın noktalar aynı
  // kareyi paylaşıyor, önbellekten anında geliyor.
  if (src && window.masaustuOnizleme) {
    const step = Math.max(5, d / 300);
    return previewImage(src, Math.round(t / step) * step, step);
  }
  if (!src || src === previewFailed) {
    previewVideo.hidden = true;
    return;
  }
  if (src !== previewFor) {
    previewFor = src;
    previewVideo.hidden = true;
    previewVideo.src = src;
  }
  previewWant = t;
  previewSeek();
}
function hideSeekTip() {
  seekTip.hidden = true;
  previewWant = null;
  imgWant = null;
}
seek.addEventListener('pointermove', (e) => {
  const r = seek.getBoundingClientRect();
  showSeekTip(Math.max(0, Math.min(r.width, e.clientX - r.left)), r.width);
});
seek.addEventListener('pointerleave', hideSeekTip);
seek.addEventListener('input', () => {
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) showSeekTip((Number(seek.value) / d) * seek.clientWidth, seek.clientWidth);
});
seek.addEventListener('change', hideSeekTip);
// Kaynak değişince önizleme eski dosyayı tutmasın.
function resetPreview() {
  previewImg.hidden = true;
  previewFor = null;
  previewVideo.removeAttribute('src');
  previewVideo.load();
  previewVideo.hidden = true;
}
video.addEventListener('emptied', resetPreview);
$('#set-seek-preview').checked = seekPreviewOn;
$('#set-seek-preview').addEventListener('change', (e) => {
  seekPreviewOn = e.target.checked;
  storage.set('seekPreview2', seekPreviewOn ? '1' : '0');
  if (!seekPreviewOn) resetPreview();
});
seek.addEventListener('change', () => {
  seeking = false;
  sync.seek(Number(seek.value));
});

// ---- Girişi atla: dizinin ilk izlenen bölümünde host'a sağ altta soruluyor: giriş kaçıncı
// saniyede bitiyor? Girilirse dizinin tüm bölümlerinde "Girişi atla" oraya atlıyor; kutu
// kapatılırsa o dizi için bir daha sorulmuyor. Değiştirme/sıfırlama Ayarlar'da (src/giris.js).
let intro = null; // { end }
let introAsked = true;
let introFor = null;
// "1:25", "01:25", "85" -> saniye
function parseClock(text) {
  const parts = String(text).trim().split(':').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !/^\d+$/.test(p)) || parts.length > 3) return null;
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}
function applyIntroState(res) {
  intro = res?.intro || null;
  introAsked = res?.asked !== false;
  renderIntroAsk();
  renderIntroSettings();
  renderShortcuts();
}
function refreshIntro() {
  const id = state.room?.contentId ?? null;
  if (id === introFor) return;
  introFor = id;
  applyIntroState(null);
  if (state.room?.type !== 'series') return;
  request('introInfo').then((res) => { if (introFor === id) applyIntroState(res); });
}
async function setIntro(body) {
  const res = await request('introSet', body);
  if (res?.error) {
    toast(errorText(res.error));
    return false;
  }
  applyIntroState(res);
  return true;
}
function renderSkipIntro() {
  const t = video.currentTime;
  $('#skip-intro').hidden = !(intro && canControl() && t < intro.end - 3 && t >= 0);
}
function renderIntroAsk() {
  $('#intro-ask').hidden = !(isHost() && state.room?.type === 'series' && !introAsked);
}
video.addEventListener('timeupdate', renderSkipIntro);

// Dizide son %5'e gelince (jenerik) aynı yerde "Sonraki bölüm" düğmesi; ✕ ile o bölüm için
// kapanıyor. Bölümü yalnızca host değiştirebildiği için host'a çıkıyor.
let nextEpDismissed = null;
// Yüzdeler Ayarlar'dan (host'un kendi cihazında saklanıyor). Otomatik geçiş 0 = kapalı.
const pctSetting = (key, def, min, max) => {
  const n = Number(storage.get(key));
  return Number.isFinite(n) && storage.get(key) !== null && n >= min && n <= max ? n : def;
};
let nextEpPct = pctSetting('sonrakiDugmePct', 5, 1, 30);
let autoNextPct = pctSetting('otomatikGecisPct', 1, 0, 30);
function renderNextEp() {
  const d = video.duration;
  const id = state.room?.contentId;
  const show = isHost() && state.room?.type === 'series' && Number.isFinite(d) && d > 120
    && video.currentTime >= d * (1 - Math.max(nextEpPct, autoNextPct) / 100) && nextEpDismissed !== id;
  $('#next-ep').hidden = !show;
  // Son %1'de kendiliğinden geçiyor (bölüm başına bir kez). ✕ ile kapatıldıysa geçmiyor.
  if (show && autoNextPct > 0 && video.currentTime >= d * (1 - autoNextPct / 100) && autoNextFor !== id) {
    autoNextFor = id;
    $('#next-ep').hidden = true;
    stepEpisode(1);
  }
}
let autoNextFor = null;
video.addEventListener('timeupdate', renderNextEp);
$('#next-ep-go').addEventListener('click', () => {
  $('#next-ep').hidden = true;
  stepEpisode(1);
});
$('#set-next-pct').value = String(nextEpPct);
$('#set-auto-pct').value = String(autoNextPct);
$('#set-next-pct').addEventListener('change', (e) => {
  nextEpPct = Math.max(1, Math.min(30, Math.round(Number(e.target.value)) || 5));
  e.target.value = String(nextEpPct);
  storage.set('sonrakiDugmePct', String(nextEpPct));
});
$('#set-auto-pct').addEventListener('change', (e) => {
  const n = Math.round(Number(e.target.value));
  autoNextPct = Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 1;
  e.target.value = String(autoNextPct);
  storage.set('otomatikGecisPct', String(autoNextPct));
});
$('#next-ep-close').addEventListener('click', () => {
  nextEpDismissed = state.room?.contentId ?? null;
  $('#next-ep').hidden = true;
});
setInterval(refreshIntro, 1000);
$('#skip-intro').addEventListener('click', () => {
  if (!intro) return;
  $('#skip-intro').hidden = true;
  sync.seek(intro.end);
});
$('#intro-now').addEventListener('click', () => {
  $('#intro-end').value = formatTime(video.currentTime || 0);
});
$('#intro-ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const end = parseClock($('#intro-end').value);
  if (end === null) return toast('Süreyi 1:25 ya da 85 gibi yaz.');
  if (await setIntro({ end })) toast(`Kaydedildi: bu dizide "Girişi atla" ${formatTime(end)}'e atlayacak.`, 5000);
});
$('#intro-close').addEventListener('click', () => setIntro({ dismiss: true }));

// Ayarlar penceresi: dizinin giriş ayarı (yalnızca host, dizideyken).
function renderIntroSettings() {
  const box = $('#intro-settings');
  box.hidden = !(isHost() && state.room?.type === 'series');
  if (box.hidden) return;
  $('#intro-settings-state').textContent = intro
    ? `Giriş ${formatTime(intro.end)}'de bitiyor, "Girişi atla" oraya atlıyor.`
    : introAsked ? 'Ayarlanmadı (sorulmaması seçildi).' : 'Ayarlanmadı.';
  $('#intro-settings-end').value = intro ? formatTime(intro.end) : '';
}
$('#intro-settings-save').addEventListener('click', async () => {
  const end = parseClock($('#intro-settings-end').value);
  if (end === null) return toast('Süreyi 1:25 ya da 85 gibi yaz.');
  if (await setIntro({ end })) toast('Giriş bitişi kaydedildi.');
});
$('#intro-settings-reset').addEventListener('click', async () => {
  if (await setIntro({ reset: true })) toast('Sıfırlandı: bir sonraki açılışta yeniden sorulacak.');
});

video.addEventListener('timeupdate', () => {
  if (!seeking) seek.value = String(video.currentTime);
  $('#time').textContent = formatTime(video.currentTime);
  $('#dur').textContent = formatTime(video.duration);
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
setIcon($('#btn-mute'), volumeIcon()); // kayıtlı düzeye göre başlasın
volume.addEventListener('input', () => {
  video.volume = Number(volume.value);
  video.muted = video.volume === 0;
  storage.set('volume', volume.value);
  window.masaustuBilgi?.(`Ses %${Math.round(Number(volume.value) * 100)}`);
});
$('#btn-mute').addEventListener('click', () => {
  video.muted = !video.muted;
});
// Ses simgesi düzeye göre: kapalı, kısık, orta, yüksek.
function volumeIcon() {
  const v = video.volume;
  return video.muted || v === 0 ? 'mute' : v < 0.34 ? 'vol0' : v < 0.67 ? 'vol1' : 'vol2';
}
video.addEventListener('volumechange', () => {
  setIcon($('#btn-mute'), volumeIcon());
});
// Kaydırıcı sürüklenirken de anında güncellensin (masaüstü/telefon oynatıcısı olayı geç yolluyor).
$('#volume').addEventListener('input', () => { setIcon($('#btn-mute'), volumeIcon()); });

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (playerEl.requestFullscreen) return playerEl.requestFullscreen().catch(() => {});
  if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iOS
}
$('#btn-fs').addEventListener('click', toggleFullscreen);
for (const [id, name] of [['btn-prev', 'prev'], ['btn-next', 'next'], ['btn-compat', 'compat'], ['btn-info', 'info'], ['btn-audio', 'audio'],
  ['btn-subs-panel', 'subs'], ['btn-chat', 'chat'], ['btn-react', 'react'], ['btn-episodes', 'episodes'], ['btn-fs', 'fs'], ['btn-more', 'more']]) setIcon($(`#${id}`), name);
document.addEventListener('fullscreenchange', () => setIcon($('#btn-fs'), document.fullscreenElement ? 'fsExit' : 'fs'));

// ---- kontrol çubuğu kutuları (Stremio düzeni) ----
// Altyazı/Dil ve Sohbet: yan panel görünüyorsa o sekmeye geçer; görünmüyorsa (tam ekran,
// telefonda yatay) sekmenin kendisi oynatıcının içine, sağ alttaki kutuya taşınır.
// Diğer kutular (bilgi, ses dili, bölümler, ⋯) her zaman oynatıcının üstünde açılır.
const tabBodies = {};
for (const name of ['subs', 'chat']) {
  const body = document.querySelector(`.tab-body[data-tab="${name}"]`);
  tabBodies[name] = { body, parent: body.parentElement, next: body.nextElementSibling };
}
let openPop = null;
function sideVisible() {
  const side = document.querySelector('.side');
  return Boolean(side && side.offsetParent !== null && !document.fullscreenElement);
}
function returnTab(name) {
  const t = tabBodies[name];
  if (t.body.parentElement !== playerEl) return;
  t.body.classList.remove('ctl-pop');
  t.parent.insertBefore(t.body, t.next);
  t.body.hidden = !document.querySelector(`.tabs button[data-tab="${name}"]`)?.classList.contains('active');
}
function closePops() {
  for (const p of document.querySelectorAll('.player > .ctl-pop[id^="pop-"]')) p.hidden = true;
  returnTab('subs');
  returnTab('chat');
  for (const b of document.querySelectorAll('.ctl-row .ctl.active-pop')) b.classList.remove('active-pop');
  openPop = null;
}
function togglePop(name, button) {
  const again = openPop === name;
  closePops();
  if (again) return;
  if (tabBodies[name]) {
    if (sideVisible()) {
      document.querySelector(`.tabs button[data-tab="${name}"]`)?.click();
      return;
    }
    const { body } = tabBodies[name];
    body.classList.add('ctl-pop');
    playerEl.append(body);
    body.hidden = false;
    if (name === 'subs') subs?.rerender();
    if (name === 'chat') $('#chat-list').scrollTop = $('#chat-list').scrollHeight;
  } else {
    POP_RENDER[name]?.(true);
    $(`#${name}`).hidden = false;
  }
  openPop = name;
  button?.classList.add('active-pop');
}
$('#btn-subs-panel').addEventListener('click', (e) => togglePop('subs', e.currentTarget));
$('#btn-chat').addEventListener('click', (e) => togglePop('chat', e.currentTarget));
for (const b of document.querySelectorAll('.ctl-row [data-pop]')) b.addEventListener('click', () => togglePop(b.dataset.pop, b));
document.addEventListener('fullscreenchange', closePops);
// Kutunun ve düğmelerin dışına tıklayınca kapanır.
document.addEventListener('pointerdown', (e) => {
  if (openPop && !e.target.closest('.player > .ctl-pop, .ctl-row, dialog')) closePops();
});

// Ses dili: dosyada birden fazla ses parçası varsa düğme görünür.
function renderAudioPop() {
  const tracks = audioTracksList();
  $('#pop-audio').replaceChildren(
    el('h3', { text: 'Ses dili' }),
    el('ul', { class: 'pop-list' }, ...tracks.map((t) => el('li', {},
      el('button', {
        type: 'button', class: t.active ? 'current' : '', text: t.label,
        onclick: () => { selectAudioTrack(t.id); setTimeout(renderAudioPop, 300); },
      })))),
  );
}

// Bölümler (dizide): sezon seçici ve resimli bölüm listesi; host tıklayınca bölüm değişir.
let episodesCache = null;
let popSeason = null;
async function loadEpisodes(force = false) {
  const series = currentSeries();
  if (!series) return null;
  if (!force && episodesCache?.id === series.id) return episodesCache;
  const res = await request('seriesEpisodes', { id: series.id });
  if (res?.error) return episodesCache?.id === series.id ? episodesCache : null;
  episodesCache = { id: series.id, episodes: res.episodes, watched: new Set(res.watched || []) };
  return episodesCache;
}
async function renderEpisodesPop(refresh = false) {
  const box = $('#pop-episodes');
  const series = currentSeries();
  if (!series) return box.replaceChildren(el('p', { class: 'muted', text: 'Bu bir dizi değil.' }));
  if (episodesCache?.id !== series.id) box.replaceChildren(el('p', { class: 'muted', text: 'Bölümler yükleniyor…' }));
  const data = await loadEpisodes(refresh);
  if (!data) return box.replaceChildren(el('p', { class: 'muted', text: 'Bölüm listesi alınamadı.' }));
  const seasons = [...new Set(data.episodes.map((e) => e.season))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  if (refresh || !seasons.includes(popSeason)) popSeason = seasons.includes(series.season) ? series.season : seasons[0];
  const i = seasons.indexOf(popSeason);
  const go = (d) => { popSeason = seasons[i + d]; renderEpisodesPop(); };
  const seasonName = (n) => (n === 0 ? 'Özel' : `Sezon ${n}`);
  const host = isHost();
  const list = el('ul', { class: 'ep-list' }, ...data.episodes.filter((e) => e.season === popSeason).map((ep) => {
    const playing = ep.season === series.season && ep.episode === series.episode;
    const seen = data.watched.has(`${ep.season}:${ep.episode}`);
    const date = ep.released ? new Date(ep.released).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const li = el('li', { class: [playing ? 'current' : '', host && !playing ? 'secilebilir' : ''].join(' ') },
      ep.thumbnail ? el('img', { src: ep.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ep-bos' }),
      el('div', { class: 'ep-bilgi' },
        el('div', { class: 'ep-ad', text: `${ep.episode}. ${ep.name}` }),
        el('div', { class: 'ep-tarih', text: [date, playing ? '▶ şu an' : seen ? '✓ izlendi' : ''].filter(Boolean).join(' · ') })));
    if (host && !playing) li.addEventListener('click', () => { closePops(); changeEpisode(series.id, ep); });
    return li;
  }));
  box.replaceChildren(
    el('h3', { text: `📺 ${series.name}` }),
    el('div', { class: 'ep-head' },
      el('button', { type: 'button', text: '‹ Önceki', disabled: i <= 0, onclick: () => go(-1) }),
      el('select', { onchange: (e) => { popSeason = Number(e.target.value); renderEpisodesPop(); } },
        ...seasons.map((n) => el('option', { value: String(n), selected: n === popSeason }, seasonName(n)))),
      el('button', { type: 'button', text: 'Sonraki ›', disabled: i >= seasons.length - 1, onclick: () => go(1) })),
    list,
    ...(host ? [] : [el('p', { class: 'muted small', text: 'Bölümü host değiştirebilir.' })]),
  );
  const cur = list.querySelector('.current');
  if (cur) box.scrollTop = cur.offsetTop - box.clientHeight / 2;
}
async function changeEpisode(id, ep) {
  toast(`${ep.season}. sezon ${ep.episode}. bölüm açılıyor…`);
  const res = await request('changeContent', { type: 'series', id: `${id}:${ep.season}:${ep.episode}` });
  if (res?.error) toast(errorText(res.error));
}
// Oynat düğmesinin yanındaki ⏮ ⏭: dizinin önceki/sonraki bölümü (sezon geçişi dahil, özel bölümler hariç).
async function stepEpisode(d) {
  const series = currentSeries();
  const data = series && (await loadEpisodes());
  if (!data) return toast('Bölüm listesi alınamadı.');
  const eps = data.episodes.filter((e) => e.season !== 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
  const i = eps.findIndex((e) => e.season === series.season && e.episode === series.episode);
  const target = i >= 0 ? eps[i + d] : null;
  if (!target) return toast(d > 0 ? 'Sonraki bölüm yok.' : 'Önceki bölüm yok.');
  changeEpisode(series.id, target);
}
$('#btn-next').addEventListener('click', () => stepEpisode(1));
$('#btn-prev').addEventListener('click', () => stepEpisode(-1));
function renderCtlButtons() {
  const series = currentSeries();
  $('#btn-episodes').hidden = !series;
  $('#btn-next').hidden = !series || !isHost();
  $('#btn-prev').hidden = !series || !isHost();
  $('#btn-audio').hidden = audioTracksList().length < 2;
  renderIntroAsk();
}
setInterval(renderCtlButtons, 1000);

// ⋯ menüsü: yayın/magnet linki, indirme, VLC'de açma.
function streamLink() {
  const s = myStream();
  if (!s) return null;
  if (s.kind === 'torrent') {
    if (player.status().source === 'relay' && state.relayKey) return `${location.origin}/relay/${roomId}/${state.relayKey}${torrentPath(s)}`;
    return `${STREMIO_BASE}${torrentPath(s)}`;
  }
  return s.url ? new URL(s.url, location.href).href : null;
}
function magnetLink() {
  const s = myStream();
  if (s?.kind !== 'torrent' || !s.infoHash) return null;
  const name = state.room?.meta?.name;
  return `magnet:?xt=urn:btih:${s.infoHash}${name ? `&dn=${encodeURIComponent(name)}` : ''}`;
}
function titleForFile() {
  return String(state.room?.meta?.name || 'video').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'video';
}
async function playInVlc() {
  const url = streamLink();
  if (!url) return toast('Açık bir video yok.');
  if (window.masaustuHarici) {
    const ok = await window.masaustuHarici.vlc(url, titleForFile(), video.currentTime || 0);
    if (!ok) toast("VLC bulunamadı. videolan.org'dan kurabilirsin.", 6000);
    return;
  }
  // Tarayıcı: VLC'nin açtığı .m3u listesi indiriliyor (Stremio da böyle yapıyor).
  const blob = new Blob([`#EXTM3U\n#EXTINF:-1,${titleForFile()}\n${url}\n`], { type: 'audio/x-mpegurl' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${titleForFile()}.m3u` });
  document.body.append(a);
  a.click();
  a.remove();
}
function downloadVideo() {
  const url = streamLink();
  if (!url) return toast('Açık bir video yok.');
  if (window.masaustuHarici) return window.masaustuHarici.indir(url, titleForFile());
  window.open(url, '_blank', 'noopener');
}
function renderMorePop() {
  const item = (icon, text, fn, disabled = false) => el('li', {},
    el('button', { type: 'button', disabled, onclick: () => { closePops(); fn(); } }, el('span', { class: 'pop-ic', text: icon }), text));
  const link = streamLink();
  const magnet = magnetLink();
  $('#pop-more').replaceChildren(el('ul', { class: 'pop-list pop-menu' },
    item('🔗', 'Yayın linkini kopyala', async () => { if (await copyText(link)) toast('Yayın linki kopyalandı.'); }, !link),
    item('🧲', 'Magnet linkini kopyala', async () => { if (await copyText(magnet)) toast('Magnet linki kopyalandı.'); }, !magnet),
    item('⬇️', 'Bu videoyu indir', downloadVideo, !link),
    item('🔶', "VLC'de aç", playInVlc, !link)));
}

const POP_RENDER = {
  'pop-info': () => renderPictureInfo(),
  'pop-audio': renderAudioPop,
  'pop-episodes': renderEpisodesPop,
  'pop-more': renderMorePop,
};
video.addEventListener('dblclick', toggleFullscreen);

// ---- Zayıf kaynak: izlenen torrent'e 1 dakikadır 5'ten az kişi bağlıysa ve hız videonun
// ihtiyacının altındaysa, en iyi 4 aday arka planda gerçekten denenir (bağlanan kişi, gerçek
// hız); belirgin şekilde daha hızlısı varsa host'a sağ altta tek tıkla geçiş önerilir.
// Oda yeni açıldığında da aynı kontrol çalışıyor: ilk dakikada zayıfsa hemen öneriliyor.
let weakSince = null;
let weakCheckedFor = null;
let weakSuggestion = null;
async function checkWeakSource() {
  const s = myStream();
  if (!isHost() || s?.kind !== 'torrent' || state.room?.hostStreamId !== s.streamId) {
    weakSince = null;
    return;
  }
  const ts = state.room.torrentStats?.[s.streamId];
  const need = requiredMbps(s.sizeBytes, player.duration()) || 8;
  // Zayıf: az kişi ve yavaş, ya da video hiç başlayamıyor (yükleniyor/donuyor).
  const st = player.status();
  const stuck = ['loading', 'buffering'].includes(st.state) && (Number(ts?.downMbps) || 0) < need;
  const weak = (ts && ts.peers < 5 && (Number(ts.downMbps) || 0) < need) || stuck;
  if (!weak) {
    weakSince = null;
    return;
  }
  weakSince ||= Date.now();
  // Önce seçilen kaynağa süre tanı: 45 sn boyunca zayıf kalırsa diğerlerini ara.
  if (Date.now() - weakSince < 45_000 || weakCheckedFor === s.streamId) return;
  weakCheckedFor = s.streamId;
  // Adaylar: aynı kalite önce, sezon paketi sona, çok kaynaklı önce.
  const hedefKalite = preferredQuality || s.quality;
  const score = (x) => (Number(x.seeders) || 0) * (x.pack ? 0.35 : 1) * (x.quality === hedefKalite ? 3 : 1);
  const candidates = state.room.streams
    .filter((x) => x.kind === 'torrent' && x.streamId !== s.streamId && x.infoHash !== s.infoHash)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 4);
  if (!candidates.length) return;
  await Promise.all(candidates.map((x) => checkStream(x.streamId)));
  const tested = candidates
    .map((x) => ({ s: x, r: streamChecks.get(x.streamId)?.result }))
    .filter((x) => x.r?.alive && Number.isFinite(x.r.downMbps))
    .sort((a, b) => b.r.downMbps - a.r.downMbps);
  const best = tested[0];
  const cur = Number(state.room.torrentStats?.[s.streamId]?.downMbps) || 0;
  if (!best || best.r.downMbps < Math.max(cur * 1.5, cur + 5)) {
    // Daha iyisi yok: bir süre sonra tekrar bakılabilsin.
    setTimeout(() => { if (weakCheckedFor === s.streamId) weakCheckedFor = null; }, 3 * 60_000);
    return;
  }
  weakSuggestion = best.s.streamId;
  // Video hiç başlayamadıysa sormadan geç (kaybedilecek bir şey yok).
  if (player.status().state === 'loading' && (video.currentTime || 0) < 2) {
    const res = await request('setHostStream', { streamId: best.s.streamId });
    if (!res?.error) {
      toast(`Seçilen kaynak açılamadı; daha hızlısına geçildi (${best.s.quality || '?'} · ${best.r.downMbps.toFixed(0)} Mbps).`, 6000);
      playAfterSwitch();
      return;
    }
  }
  $('#weak-src-text').textContent = `Bu kaynak zayıf (${ts?.peers ?? 0} kişi, ${cur.toFixed(0)} Mbps). `
    + `Daha hızlısı: ${best.s.quality || '?'}${best.s.hdr ? ` ${best.s.hdr}` : ''} · ${best.r.downMbps.toFixed(0)} Mbps · ${best.r.peers} kişi`;
  $('#weak-src').hidden = false;
}
setInterval(checkWeakSource, 5000);
$('#weak-src-go').addEventListener('click', async () => {
  $('#weak-src').hidden = true;
  if (!weakSuggestion) return;
  const res = await request('setHostStream', { streamId: weakSuggestion });
  if (res?.error) toast(errorText(res.error));
  else playAfterSwitch();
});
$('#weak-src-close').addEventListener('click', () => { $('#weak-src').hidden = true; });

// ---- Sonraki bölümü önceden hazırla: dizide son 5 dakikada (bölüm başına bir kez) sunucu
// sıradaki bölümün en iyi kaynağını seçip Stremio'da açıyor; geçişte bekleme olmuyor.
let prefetchedFor = null;
video.addEventListener('timeupdate', () => {
  const d = video.duration;
  const id = state.room?.contentId;
  if (!isHost() || state.room?.type !== 'series' || !Number.isFinite(d) || d < 600) return;
  if (d - video.currentTime > 300 || prefetchedFor === id) return;
  prefetchedFor = id;
  request('prefetchNext').catch(() => {});
});

// ---- Tepki emojileri: videonun üstünde uçuyor. Masaüstünde (mpv) HTML videonun üstüne
// çıkamadığı için tam ekran sohbet katmanında gösteriliyor.
const REACTIONS = ['😂', '🔥', '❤️', '😮', '👏', '😢'];
$('#pop-react').replaceChildren(...REACTIONS.map((emoji) => el('button', {
  type: 'button', class: 'react-btn', text: emoji,
  onclick: () => request('react', { emoji }).then((res) => { if (res?.error) toast(errorText(res.error)); }),
})));
socket.on('reaction', ({ emoji, name }) => {
  if (window.masaustuSohbet) {
    window.masaustuSohbet(name, emoji);
    return;
  }
  const node = el('div', { class: 'react-fly', text: emoji, title: name });
  node.style.left = `${10 + Math.random() * 70}%`;
  playerEl.append(node);
  setTimeout(() => node.remove(), 2600);
});

// ---- Tercih edilen kalite: uygulamada ilk girişte soruluyor, kaydediliyor. Kalite listesinde
// o kalite en üstte; host'ta o kalitenin en çok kaynaklı torrent'leri kendiliğinden denetleniyor.
const QUALITY_CHOICES = [['2160p', '4K (2160p)'], ['1080p', '1080p'], ['720p', '720p']];
function setPreferredQuality(q) {
  preferredQuality = q;
  storage.set('tercihKalite', q);
  // Uygulamanın kaydına da yaz: açılış ekranı ve sonraki odalar aynı tercihi görsün.
  window.kabuk?.kaliteYaz?.(q);
  window.mobilKaliteYaz?.(q);
  $('#set-pref-quality').value = q;
  if (isHost()) request('setPreferredQuality', { quality: q }).catch(() => {});
  preferredCheckedFor = null;
  renderQualityTab();
  checkPreferredStreams();
}
function askPreferredQuality() {
  if (!state.room || preferredQuality || !window.masaustuSes || $('#pref-dialog').open || document.querySelector('dialog[open]')) return;
  $('#pref-choices').replaceChildren(...QUALITY_CHOICES.map(([q, label]) => el('button', {
    type: 'button', class: q === '2160p' ? 'primary' : '', text: label,
    onclick: () => { setPreferredQuality(q); $('#pref-dialog').close(); },
  })));
  $('#pref-dialog').showModal();
}
$('#set-pref-quality').replaceChildren(el('option', { value: '', text: 'Seçilmedi' }),
  ...QUALITY_CHOICES.map(([q, label]) => el('option', { value: q, text: label })));
$('#set-pref-quality').value = preferredQuality || '';
$('#set-pref-quality').addEventListener('change', (e) => { if (e.target.value) setPreferredQuality(e.target.value); });

// Host: tercih edilen kalitenin en çok kaynaklı 4 torrent'i gerçekten denenir (bağlanan kişi, hız).
let preferredCheckedFor = null;
let preferredSent = false;
function checkPreferredStreams() {
  if (!isHost() || !preferredQuality || !state.room?.streams?.length) return;
  // Denemeler Stremio'da başka torrent'ler açıyor ve hız paylaşıyor: seçilen video açılıp önünde
  // yeterince hazır veri olmadan başlatma (yoksa video, denemeler bitene kadar açılmıyordu).
  if (player.status().state !== 'ready' || (liveDownload().ahead || 0) < 20) return;
  // Oda aç ekranı da bilsin (host olunca bir kez).
  if (!preferredSent) {
    preferredSent = true;
    request('setPreferredQuality', { quality: preferredQuality }).catch(() => {});
  }
  const key = `${state.room.contentId}|${preferredQuality}`;
  if (preferredCheckedFor === key) return;
  preferredCheckedFor = key;
  const top = state.room.streams
    .filter((s) => s.kind === 'torrent' && s.quality === preferredQuality && !streamChecks.has(s.streamId))
    .sort((a, b) => (Number(b.seeders) || 0) - (Number(a.seeders) || 0))
    .slice(0, 4);
  for (const s of top) checkStream(s.streamId);
}
// Açılışta yalnızca seçilen kaynak: tercih kalitesinin diğer kaynakları ancak seçilen kaynak
// zayıf kalırsa (bkz. checkWeakSource) deneniyor.
setInterval(askPreferredQuality, 3000);

// ---- content search (host only): switch the room to a different title ----
let searchSeq = 0;
let lastSearchResults = [];

async function pickContent(type, id, item) {
  if (item.classList.contains('loading')) return;
  item.classList.add('loading');
  const prevText = item.querySelector('.name').textContent;
  item.querySelector('.name').textContent = `${prevText} — yükleniyor…`;
  const res = await request('changeContent', { type, id });
  if (res?.error) {
    toast(errorText(res.error));
    item.classList.remove('loading');
    item.querySelector('.name').textContent = prevText;
  }
}

// Boş aramada odanın dizisini göster. Hata olursa tekrar denemiyoruz (sonsuz döngü olmasın).
let seriesShownFor = null;
function showCurrentSeries() {
  const series = currentSeries();
  if (!series) return false;
  if (seriesShownFor === state.room.contentId && $('#search-results').querySelector('.season-tabs')) return true;
  seriesShownFor = state.room.contentId;
  openEpisodePicker(series, { current: series });
  return true;
}

// Oda bir dizideyse: "tt123:3:1" -> { id: 'tt123', season: 3, episode: 1 }.
function currentSeries() {
  if (state.room?.type !== 'series') return null;
  const [id, season, episode] = String(state.room.contentId || '').split(':');
  if (!id) return null;
  // Başlık "Silo S03E01 · Who Are You?" gibi geliyor; bölüm kısmını atıyoruz.
  const name = (state.room.meta?.name || id).replace(/\s+S\d+E\d+.*$/, '');
  return { id, name, season: Number(season) || null, episode: Number(episode) || null };
}

async function openEpisodePicker(series, { current = null } = {}) {
  const box = $('#search-results');
  box.replaceChildren(el('li', { class: 'muted', text: 'Bölümler yükleniyor…' }));
  const res = await request('seriesEpisodes', { id: series.id });
  if (res?.error) {
    toast(errorText(res.error));
    // Odanın dizisi yüklenemediyse boş aramaya dön; renderSearchResults'a dönmek
    // aynı diziyi tekrar açmayı deneyip döngüye girerdi.
    if (current) return box.replaceChildren(el('li', { class: 'muted', text: 'Aramak için yaz.' }));
    return renderSearchResults(lastSearchResults);
  }
  // Daha önce açılmış bölümler (host'un geçmişi): "✓ izlendi" işareti.
  const watched = new Set(res.watched || []);
  const bySeason = new Map();
  for (const ep of res.episodes) {
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
    bySeason.get(ep.season).push(ep);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  let currentSeason = current?.season && bySeason.has(current.season)
    ? current.season
    : seasons.find((s) => s !== 0) ?? seasons[0];

  // Odanın kendi dizisi açıkken "geri" diye bir yer yok: başlık yalnızca bilgi.
  const back = current
    ? el('div', { class: 'search-back', text: `📺 ${series.name} · şu an izlenen dizi` })
    : el('button', { type: 'button', class: 'search-back', text: `◀ ${series.name}` });
  if (!current) back.addEventListener('click', () => renderSearchResults(lastSearchResults));
  const seasonTabs = el('div', { class: 'season-tabs' });
  const list = el('ul', { class: 'search-results' });

  function renderEpisodes() {
    for (const b of seasonTabs.children) b.classList.toggle('active', Number(b.dataset.season) === currentSeason);
    list.replaceChildren(...bySeason.get(currentSeason).map((ep) => {
      const playing = current && ep.season === current.season && ep.episode === current.episode;
      const seen = watched.has(`${ep.season}:${ep.episode}`);
      // Solda bölüm resmi; altta yalnızca tarih ve durum (sezon zaten üstteki sekmede seçili).
      const date = ep.released ? new Date(ep.released).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      const item = el(
        'li',
        { class: `ep-item${playing ? ' current' : ''}` },
        ep.thumbnail ? el('img', { class: 'ep-resim', src: ep.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ep-resim' }),
        el('div', { class: 'info' },
          el('div', { class: 'name', text: `${ep.episode}. ${ep.name}` }),
          el('div', { class: 'year', text: [date, playing ? '▶ şu an' : seen ? '✓ izlendi' : ''].filter(Boolean).join(' · ') })),
      );
      item.addEventListener('click', () => pickContent('series', `${series.id}:${ep.season}:${ep.episode}`, item));
      return item;
    }));
  }
  seasonTabs.replaceChildren(...seasons.map((s) => {
    const b = el('button', { type: 'button', text: s === 0 ? 'Özel' : `S${s}`, 'data-season': String(s) });
    b.addEventListener('click', () => { currentSeason = s; renderEpisodes(); });
    return b;
  }));
  renderEpisodes();
  box.replaceChildren(back, seasonTabs, list);
}

function renderSearchResults(results) {
  lastSearchResults = results;
  const box = $('#search-results');
  if (!results.length) {
    const empty = !$('#search-input').value.trim();
    if (empty && showCurrentSeries()) return;
    box.replaceChildren(el('li', { class: 'muted', text: empty ? 'Aramak için yaz.' : 'Sonuç yok.' }));
    return;
  }
  box.replaceChildren(...results.map((r) => {
    const item = el(
      'li',
      {},
      r.poster ? el('img', { src: r.poster, alt: '' }) : el('div', { class: 'ph' }),
      el('div', { class: 'info' },
        el('div', { class: 'name', text: r.name }),
        el('div', { class: 'year', text: [r.type === 'series' ? 'Dizi' : 'Film', r.year].filter(Boolean).join(' · ') })),
    );
    item.addEventListener('click', () => (r.type === 'series' ? openEpisodePicker(r) : pickContent(r.type, r.id, item)));
    return item;
  }));
}
// A pasted magnet link (or bare infoHash) is not a catalog search: offer to play it directly.
const MAGNET_INPUT = /^(magnet:\?|[0-9a-f]{40}$)/i;
function renderMagnetRow(text) {
  const name = new URLSearchParams(text.slice(text.indexOf('?') + 1)).get('dn');
  const item = el(
    'li',
    {},
    el('div', { class: 'ph' }, '🧲'),
    el('div', { class: 'info' },
      el('div', { class: 'name', text: name || 'Magnet linki' }),
      el('div', { class: 'year', text: 'Odaya kaynak olarak ekle ve herkes için seç' })),
  );
  item.addEventListener('click', async () => {
    item.classList.add('busy');
    const res = await request('addMagnet', { magnet: text });
    item.classList.remove('busy');
    if (res?.error) return toast(errorText(res.error));
    $('#search-input').value = '';
    renderSearchResults([]);
    toast('Magnet eklendi ve herkes için seçildi.');
  });
  $('#search-results').replaceChildren(item);
}

async function runSearch() {
  const q = $('#search-input').value.trim();
  const seq = ++searchSeq;
  if (MAGNET_INPUT.test(q)) return renderMagnetRow(q);
  if (q.length < 2) return renderSearchResults([]);
  $('#search-results').replaceChildren(el('li', { class: 'muted', text: 'Aranıyor…' }));
  const res = await request('searchContent', { query: q });
  if (seq !== searchSeq) return; // a newer search started meanwhile
  renderSearchResults(res?.results || []);
}
let searchDebounce = null;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(runSearch, 400);
});
renderSearchResults([]);

// ---- compat-mode resolution picker: a popover opened from the player's 🛠 button ----
function reloadCompatTier() {
  if (!loaded.compat) return;
  const s = myStream();
  if (!s) return;
  player.load(s, { forceFallback: true, compat: true });
}

function renderCompatTier() {
  const box = $('#compat-popover');
  for (const b of box.children) b.classList.toggle('active', b.dataset.q === (loaded.compat ? compatTier : 'normal'));
}
function selectCompatTier(q) {
  $('#compat-popover').hidden = true;
  if (q === 'normal') {
    if (loaded.compat) stopCompat();
    renderCompatTier();
    return;
  }
  compatTier = q;
  storage.set('compatTier', q);
  // Picking a resolution is itself consent to convert the picture if needed
  // (that's what "kaliteyi düşür" means); asking again would just be in the way.
  if (loaded.compat) reloadCompatTier();
  else startCompat({ allowReencode: true });
  renderCompatTier();
}
for (const b of document.querySelectorAll('#compat-popover button')) {
  b.addEventListener('click', () => selectCompatTier(b.dataset.q));
}
$('#btn-compat').addEventListener('click', () => {
  const box = $('#compat-popover');
  box.hidden = !box.hidden;
});
renderCompatTier();

// ---- hardware acceleration check ----
function renderHw() {
  const box = $('#hw-status');
  if (!hw) return;
  const info = (text) => el('span', { class: 'info-i', tabindex: '0', title: text }, 'ⓘ');
  if (hw.gpu) {
    box.className = 'small ok row-line';
    box.replaceChildren(
      '✅ Donanım hızlandırma açık',
      info(`Ekran kartı: ${gpuName(hw.renderer) || 'bilinmiyor'}${hw.hevcHardware ? '\n4K HEVC donanımla çözülüyor.' : ''}`),
    );
  } else {
    box.className = 'small bad row-line';
    box.replaceChildren(
      '⚠️ Donanım hızlandırma kapalı',
      el('button', { type: 'button', text: 'Nasıl açılır?', onclick: () => alert(HW_HELP) }),
      info('HEVC, Dolby Vision ve 4K videolar açılmayabilir ya da takılabilir.'),
    );
  }
}
const hardwareCheck = checkHardware();
hardwareCheck.then((result) => {
  hw = result;
  renderHw();
  if (!hw.gpu) toast('Tarayıcında donanım hızlandırma kapalı görünüyor. Ayrıntı: Kalite sekmesi.', 7000);
  renderNotice();
});

// ---- device compatibility screen ----
// Checks whether this device can open the room's videos (HEVC, HDR, audio codecs, Stremio…).
// It opens by itself only when something is wrong; the header button opens it any time.
const compatScreen = createCompatScreen({
  onPick: async (streamId) => {
    const res = await request('setOwnStream', { streamId: streamId === state.room.hostStreamId ? null : streamId });
    toast(res?.error ? errorText(res.error) : 'Önerilen kaynağa geçildi.');
  },
  onOpenQuality: () => selectTab('quality'),
});
let compatDevice = null;

async function refreshCompat({ auto = false, show = false } = {}) {
  if (!state.room) return;
  compatDevice ||= await probeDevice({
    codecs: browserCodecs(video),
    hw: await hardwareCheck,
    stremioUp: null,
    touch: isTouch,
  });
  compatDevice = { ...compatDevice, stremio: isTouch ? null : await isStremioUp() };
  if (!state.room) return;
  // Guests only ever see torrents plus the host's own stream, so judge exactly those.
  const streams = state.room.streams.filter((s) => s.kind === 'torrent' || s.streamId === state.room.hostStreamId);
  const result = evaluateCompat({
    device: compatDevice,
    streams,
    current: myStream(),
    isHost: isHost(),
    relayEnabled: state.room.settings.relayEnabled,
  });
  const data = { result, device: compatDevice, currentStreamId: myStreamId() };
  const issues = result.problems.filter((p) => p.level !== 'info').length;
  $('#compat-badge').hidden = !issues;
  $('#compat-badge').textContent = String(issues);
  compatScreen.update(data);
  if (show) return compatScreen.show(data);
  // Masaüstü kabuğunda uyumluluk uyarıları anlamsız: görüntüyü mpv çiziyor, her biçimi açıyor.
  if (auto && result.needsAttention && !window.masaustuSes) {
    const muted = new Set((storage.get('compatSeen') || '').split(',').filter(Boolean));
    if (result.problems.some((p) => p.level !== 'info' && !muted.has(p.id))) compatScreen.show(data);
  }
}
$('#open-compat').addEventListener('click', () => refreshCompat({ show: true }));

// ---- picture adjustment (brightness / contrast / colour), per viewer ----
// SDR gets one set. HDR gets 3 switchable profiles: HDR brightness needs vary a
// lot by screen/room, so one slider would fight itself across setups.
const PIC_KEYS = { b: 'brightness', c: 'contrast', s: 'saturate' };
const HDR_PROFILES = ['1', '2', '3'];
const pic = {};
let picMode = null; // 'SDR' | 'HDR'
let hdrProfile = HDR_PROFILES.includes(storage.get('hdrProfile')) ? storage.get('hdrProfile') : '1';
const picKey = () => (picMode === 'HDR' ? `HDR_${hdrProfile}` : 'SDR');
function loadPic() {
  for (const k of Object.keys(PIC_KEYS)) {
    const saved = Number(storage.get(`pic${k.toUpperCase()}_${picKey()}`));
    pic[k] = Number.isFinite(saved) && saved > 0 ? saved : 1;
  }
}
function renderHdrProfiles() {
  $('#hdr-profiles').hidden = picMode !== 'HDR';
  for (const b of $('#hdr-profiles').children) b.classList.toggle('active', b.dataset.profile === hdrProfile);
}
function applyPic() {
  const mode = myStream()?.hdr ? 'HDR' : 'SDR';
  if (mode !== picMode) {
    picMode = mode;
    loadPic();
  }
  const changed = Object.keys(PIC_KEYS).some((k) => pic[k] !== 1);
  video.style.filter = changed ? Object.entries(PIC_KEYS).map(([k, fn]) => `${fn}(${pic[k]})`).join(' ') : '';
  for (const k of Object.keys(PIC_KEYS)) {
    $(`#pic-${k}`).value = String(pic[k]);
    $(`#pic-${k}-val`).textContent = `%${Math.round(pic[k] * 100)}`;
    storage.set(`pic${k.toUpperCase()}_${picKey()}`, String(pic[k]));
  }
  $('#pic-mode-label').textContent = picMode === 'HDR' ? `HDR · profil ${hdrProfile}` : 'SDR';
  renderHdrProfiles();
}
for (const k of Object.keys(PIC_KEYS)) {
  $(`#pic-${k}`).addEventListener('input', (e) => {
    pic[k] = Number(e.target.value);
    applyPic();
  });
}
$('#pic-reset').addEventListener('click', () => {
  for (const k of Object.keys(PIC_KEYS)) pic[k] = 1;
  applyPic();
});
for (const b of document.querySelectorAll('#hdr-profiles button')) {
  b.addEventListener('click', () => {
    if (b.dataset.profile === hdrProfile) return;
    hdrProfile = b.dataset.profile;
    storage.set('hdrProfile', hdrProfile);
    loadPic();
    applyPic();
  });
}
applyPic();

// Aspect modes for the player button (per viewer).
const ASPECTS = [
  ['fit', 'Sığdır'], ['fill', 'Doldur'], ['stretch', 'Uzat'],
  ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '21:9'],
];
const FIXED_RATIO = { '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9 };
let aspectMode = ASPECTS.some(([m]) => m === storage.get('aspect')) ? storage.get('aspect') : 'fit';

// Size the <video> to the picture itself so filters skip the black bars.
function fitVideo() {
  const W = playerEl.clientWidth;
  const H = playerEl.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  $('#btn-aspect').textContent = ASPECTS.find(([m]) => m === aspectMode)[1];
  // Masaüstü kabuğunda görüntüyü mpv çiziyor: oranı ona söylüyoruz (aynı değeri
  // tekrar yollamayı köprü eliyor).
  window.masaustuOran?.(aspectMode);
  if (!vw || !vh || !W || !H || aspectMode === 'stretch') {
    video.style.objectFit = 'fill';
    video.style.width = `${W || 0}px`;
    video.style.height = `${H || 0}px`;
    if (!vw || !vh || !W || !H) {
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
    }
    return;
  }
  const ratio = FIXED_RATIO[aspectMode] || vw / vh;
  // Forced ratios stretch the picture into that shape; others keep its own.
  video.style.objectFit = FIXED_RATIO[aspectMode] ? 'fill' : 'contain';
  let w = W;
  let h = W / ratio;
  const cover = aspectMode === 'fill';
  if (cover ? h < H : h > H) {
    h = H;
    w = H * ratio;
  }
  video.style.width = `${Math.floor(w)}px`;
  video.style.height = `${Math.floor(h)}px`;
}
$('#btn-aspect').addEventListener('click', () => {
  const i = ASPECTS.findIndex(([m]) => m === aspectMode);
  aspectMode = ASPECTS[(i + 1) % ASPECTS.length][0];
  storage.set('aspect', aspectMode);
  fitVideo();
  const label = `Görüntü oranı: ${ASPECTS.find(([m]) => m === aspectMode)[1]}`;
  // Masaüstünde bilgi player'ın alt ortasında (mpv'nin ekranında) çıkıyor.
  if (window.masaustuBilgi) window.masaustuBilgi(label);
  else toast(label, 1500);
});
new ResizeObserver(fitVideo).observe(playerEl);
video.addEventListener('loadedmetadata', fitVideo);
video.addEventListener('resize', fitVideo);
video.addEventListener('emptied', fitVideo);

// Bilgi simgeleri: üzerinde bekleyince title görünüyor; tıklayınca (dokunmatikte de) aynı
// metin simgenin yanında küçük bir kutuda. Toast kullanılmıyor: açık bir pencerenin
// (Ayarlar) arkasında kalıyordu. Kutu pencerenin içine ekleniyor ki üstte görünsün.
let infoTip = null;
function closeInfoTip() {
  infoTip?.remove();
  infoTip = null;
}
document.addEventListener('click', (e) => {
  const icon = e.target.closest('.info-i');
  if (!icon?.title) {
    if (!e.target.closest('.info-tip')) closeInfoTip();
    return;
  }
  e.preventDefault(); // label içindeyse kutucuğu işaretlemesin
  const same = infoTip?.owner === icon;
  closeInfoTip();
  if (same) return;
  infoTip = el('div', { class: 'info-tip', role: 'tooltip', text: icon.title });
  infoTip.owner = icon;
  (icon.closest('dialog') || document.body).append(infoTip);
  const r = icon.getBoundingClientRect();
  const w = infoTip.offsetWidth;
  const h = infoTip.offsetHeight;
  infoTip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  infoTip.style.top = `${r.bottom + 6 + h > innerHeight - 8 ? r.top - h - 6 : r.bottom + 6}px`;
});
document.addEventListener('scroll', closeInfoTip, true);

// ---- keep picture quality option ----
function renderKeepQuality() {
  $('#keep-quality').checked = keepQuality;
  $('#keep-quality-note').title = keepQuality
    ? 'Görüntü hep orijinal kalitede. Tarayıcın bir dosyanın görüntüsünü açamazsa dönüştürmek yerine sana sorulur. Ses gerekirse dönüştürülür (görüntüye dokunmaz).'
    : 'Tarayıcının açamadığı görüntü otomatik dönüştürülür; kalite düşebilir (4K → 1080p gibi).';
}
$('#keep-quality').addEventListener('change', (e) => {
  keepQuality = e.target.checked;
  storage.set('keepQuality', keepQuality ? '1' : '0');
  renderKeepQuality();
  if (state.room) {
    renderQualityTab();
    loadMyStream(true); // re-evaluate the current video with the new rule
  }
});
renderKeepQuality();
// ---- resizable side panel (desktop) ----
const SIDE_DEFAULT = 360;
const SIDE_MIN = 260;
const MIN_PLAYER = 360;
function setSideWidth(px, save = true) {
  const layout = document.querySelector('.layout');
  // Before the room is shown the layout has no width yet; only clamp once it does.
  const max = layout.clientWidth ? Math.max(SIDE_MIN, layout.clientWidth - MIN_PLAYER) : Infinity;
  const w = Math.round(Math.min(max, Math.max(SIDE_MIN, px)));
  document.documentElement.style.setProperty('--side-w', `${w}px`);
  if (save) storage.set('sideWidth', String(w));
}
{
  const saved = Number(storage.get('sideWidth'));
  if (saved) setSideWidth(saved, false);
  const resizer = $('#side-resizer');
  resizer.addEventListener('pointerdown', (e) => {
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.hasPointerCapture(e.pointerId)) return;
    setSideWidth(document.querySelector('.layout').getBoundingClientRect().right - e.clientX);
  });
  const stop = (e) => {
    if (resizer.hasPointerCapture(e.pointerId)) resizer.releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing');
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);
  resizer.addEventListener('dblclick', () => setSideWidth(SIDE_DEFAULT));
  resizer.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation(); // arrows would otherwise seek the video
    const current = $('.side').getBoundingClientRect().width;
    setSideWidth(current + (e.key === 'ArrowLeft' ? 20 : -20));
  });
}

function toggleViewersOv() {
  const ov = $('#viewers-ov');
  ov.classList.toggle('collapsed');
  storage.set('viewersCollapsed', ov.classList.contains('collapsed') ? '1' : '0');
}
$('#viewers-toggle').addEventListener('click', toggleViewersOv);
$('#viewers-ov').classList.toggle('collapsed', (storage.get('viewersCollapsed') ?? (isTouch ? '1' : '0')) === '1');
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
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // Ses %5 adımlarla; kaydırıcı ve simge de güncellensin.
    e.preventDefault();
    const v = Math.max(0, Math.min(1, Math.round((video.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)) * 20) / 20));
    volume.value = String(v);
    volume.dispatchEvent(new Event('input'));
  } else if (e.key === 's') togglePop('subs', $('#btn-subs-panel'));
  else if (e.key === 'c') togglePop('chat', $('#btn-chat'));
  else if (e.key === 'n' && isHost() && state.room?.type === 'series') stepEpisode(1);
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && canControl()) {
    sync.seek(Math.max(0, video.currentTime + (e.key === 'ArrowRight' ? 10 : -10)));
  }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => canControl() && !sync.intendsToPlay() && sync.toggle());
  navigator.mediaSession.setActionHandler('pause', () => canControl() && sync.intendsToPlay() && sync.toggle());
}

// ---- tabs, header actions, settings ------------------------------------------------------

// Odaya girince (sadece BIR kez, kalite sekmesine her girişte degil) tum eklentileri
// otomatik test etmek gercek torrent verisi cektigi icin internet tuketir (bkz.
// checkAllInTab) - mobilde veri kullanimi/pil daha kritik oldugundan bu otomasyon
// SADECE masaustunde (dokunmatik olmayan) calisir; mobilde kullanici elle "Test et"
// butonuna basmali. Cagrildigi yer: applySnapshot (ilk baglantida, reconnect'te degil).
function maybeAutoCheckQuality() {
  if (isTouch || !isHost() || checkingAll) return;
  const targets = autoScanTargets(state.room?.streams || []);
  if (targets.length) checkAllInTab(targets);
}

function selectTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const body of document.querySelectorAll('.tab-body')) body.hidden = body.dataset.tab !== name;
  // Arama boşken ve oda bir dizideyse: o dizinin bölümleri hazır gelsin.
  if (name === 'search' && !$('#search-input').value.trim()) showCurrentSeries();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));

// "İnternet" penceresi: bu cihazın video indirmesi, host bilgisayarındaki Stremio'nun
// torrent'leri (indirme + torrent kişilerine yükleme) ve host üzerinden izleyenlere giden yükleme.
const netDialog = $('#net-dialog');
let netTimer = null;
const mbps = (n) => (Number.isFinite(n) ? `${n.toFixed(1)} Mbps` : '—');
async function renderNet() {
  const mine = liveDownload();
  const src = player.status().source;
  const srcText = { local: "kendi Stremio'n", relay: 'host üzerinden (relay)', http: 'doğrudan link' }[src] || '—';
  const res = await request('bandwidth').catch(() => null);
  const rows = [
    el('h3', { text: 'Bu cihaz' }),
    el('div', { class: 'net-row' }, el('span', { text: `▶ Video (${srcText})` }), el('b', { text: `↓ ${mbps(mine.downMbps)}` })),
  ];
  if (res?.host) {
    rows.push(el('h3', { text: 'Bu bilgisayardaki Stremio' }));
    if (res.torrents === null) rows.push(el('p', { class: 'muted small', text: "Stremio'ya ulaşılamadı." }));
    else if (!res.torrents.length) rows.push(el('p', { class: 'muted small', text: 'Açık torrent yok.' }));
    let down = 0;
    let up = 0;
    for (const t of res.torrents || []) {
      down += t.downMbps;
      up += t.upMbps;
      rows.push(el('div', { class: 'net-row' },
        el('span', { class: 'net-name', title: t.name, text: `${t.role === 'bu oda' ? '🎬' : t.role === 'açık kalmış' ? '⚠️' : '🧲'} ${t.name}` },
          el('small', { class: 'muted', text: ` · ${t.role} · ${t.peers} kişi` })),
        el('b', { text: `↓ ${mbps(t.downMbps)} · ↑ ${mbps(t.upMbps)}` }),
        t.role === 'açık kalmış' ? el('button', {
          type: 'button', class: 'net-close', text: 'Kapat', title: 'Bu torrent\'i Stremio\'da kapat (internet harcamasın)',
          onclick: async () => { await request('closeTorrent', { infoHash: t.infoHash }); renderNet(); },
        }) : null));
    }
    if ((res.torrents || []).length > 1) rows.push(el('div', { class: 'net-row net-total' }, el('span', { text: 'Toplam torrent' }), el('b', { text: `↓ ${mbps(down)} · ↑ ${mbps(up)}` })));
    rows.push(el('p', { class: 'muted small', text: '↑ torrent: Stremio indirdiği parçaları başkalarına da yüklüyor (torrent böyle çalışıyor).' }));
  }
  if (res?.relay?.length || res?.host) {
    rows.push(el('h3', { text: res?.host ? 'Host üzerinden izleyenler (senin yüklemen)' : 'Host üzerinden izleme' }));
    if (!res.relay.length) rows.push(el('p', { class: 'muted small', text: 'Kimse host üzerinden izlemiyor.' }));
    for (const u of res.relay) rows.push(el('div', { class: 'net-row' }, el('span', { text: `👤 ${u.name}` }), el('b', { text: `↑ ${mbps(u.mbps)}` })));
    if (res.host && res.relay.length > 1) rows.push(el('div', { class: 'net-row net-total' }, el('span', { text: 'Toplam' }), el('b', { text: `↑ ${mbps(res.relayTotal)}` })));
  }
  $('#net-body').replaceChildren(...rows);
}
$('#net-usage').addEventListener('click', () => {
  netDialog.showModal();
  renderNet();
  clearInterval(netTimer);
  netTimer = setInterval(renderNet, 2000);
});
netDialog.addEventListener('close', () => clearInterval(netTimer));

$('#copy-link').addEventListener('click', async () => {
  const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const base = state.publicUrl || (local ? null : location.origin);
  if (!base) return toast('Tünel henüz hazır değil. Paneldeki tünel durumunu kontrol et.', 5000);
  if (await copyText(`${base}/room/${roomId}`)) toast('Link kopyalandı.');
});

// Masaüstü uygulamasında aç. Kabuk zaten masaüstüyse düğme gereksiz.
if (window.masaustuSes) $('#open-desktop').hidden = true;
else {
  $('#open-desktop').addEventListener('click', () => {
    location.href = `birlikteizle://${encodeURIComponent(location.href)}`;
    toast('Masaüstü uygulaması açılıyor. Kurulu değilse indirilen klasördeki "Birlikte Izle.exe" bir kez çalıştırılmalı.', 8000);
  });
}

// Ayarlar'daki kısayol listesi: bu cihazda hangileri geçerliyse (dokunmatik ya da klavye).
function renderShortcuts() {
  const row = (k, t) => el('div', { class: 'shortcut' }, el('kbd', { text: k }), el('span', { text: t }));
  const host = isHost();
  // Dokunma hareketleri telefon uygulamasının (window.mobilCihaz) köprüsünde; telefon
  // tarayıcısında yalnızca ekrandaki düğmeler var.
  const rows = isTouch && !window.mobilCihaz
    ? [row('Videoya dokun', 'Kontrolleri göster'), row('—', 'Kaydırma ve çift dokunma kısayolları telefon uygulamasında')]
    : isTouch
    ? [
      row('Çift dokun (sağ)', '10 sn ileri'),
      row('Çift dokun (sol)', '10 sn geri'),
      row('Sağda yukarı/aşağı kaydır', 'Ses'),
      row('Solda yukarı/aşağı kaydır', 'Parlaklık'),
      row('Ses simgesine dokun', 'Ses kaydırıcısı'),
      row('Ana ekran tuşu', 'Video küçük pencerede sürer'),
    ]
    : [
      row('Boşluk / K', 'Oynat / durdur'),
      row('← / →', '10 sn geri / ileri'),
      row('↑ / ↓', 'Ses %5'),
      row('M', 'Sessiz'),
      row('F / çift tıkla', 'Tam ekran'),
      row('S', 'Altyazı / Dil kutusu'),
      row('C', 'Sohbet'),
      host ? row('N', 'Sonraki bölüm (dizide)') : null,
    ];
  $('#shortcut-list').replaceChildren(...rows.filter(Boolean));
}

// Host kalite listesinden kaynak seçince oda duraklatılmışsa da oynamaya başlasın.
function playAfterSwitch() {
  if (canControl() && !sync.intendsToPlay()) sync.toggle();
}

// Geri: odadan çık, önceki ekrana dön (oda açık kalır, başkaları izlemeye devam eder).
// Uygulamada: "Oda aç"tan gelindiyse kaynak listesine, yoksa açılış ekranına.
function goBack() {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin !== location.origin) {
    history.back();
    return;
  }
  if (window.masaustuOdaKapandi) return window.masaustuOdaKapandi();
  history.back();
}
// Host'a sor: odadan mı çıkılsın (oda açık kalır) yoksa oda herkes için mi kapansın.
$('#room-back').addEventListener('click', () => {
  if (!isHost()) return goBack();
  $('#back-dialog').showModal();
});
$('#back-leave').addEventListener('click', () => { $('#back-dialog').close(); goBack(); });
$('#back-close').addEventListener('click', async () => {
  $('#back-dialog').close();
  const res = await request('closeRoom');
  if (res?.error) return toast(errorText(res.error));
  state.ended = true;
  goBack();
});

// Masaüstü uygulamasında: videonun ne kadar ilerisi önceden indirilsin (mpv önbelleği).
if (window.kabuk?.onbellekYaz) {
  $('#onbellek-wrap').hidden = false;
  $('#set-onbellek').value = String(window.kabuk.onbellek?.() || 180);
  $('#set-onbellek').addEventListener('change', (e) => window.kabuk.onbellekYaz(Number(e.target.value)));
}
$('#set-auto-subs').checked = storage.get('otoAltyazi') !== '0';
$('#set-auto-subs').addEventListener('change', (e) => storage.set('otoAltyazi', e.target.checked ? '1' : '0'));

const dialog = $('#settings-dialog');
$('#open-settings').addEventListener('click', () => {
  const s = state.room.settings;
  $('#set-locked').checked = s.locked;
  for (const r of dialog.querySelectorAll('input[name="waitMode"]')) r.checked = r.value === s.waitMode;
  $('#set-relay').checked = s.relayEnabled;
  $('#set-relay-limit').value = String(s.relayLimit);
  $('#set-relay4k').checked = Boolean(s.relay4k);
  $('#set-stop-others').checked = s.stopOtherDownloads !== false;
  renderIntroSettings();
  dialog.showModal();
});
dialog.addEventListener('change', async (e) => {
  // Bu cihazın ayarları (kalite, donanım) kendi dinleyicilerinde; burası yalnızca oda ayarları.
  if (!isHost() || !e.target.closest('#room-settings') || e.target.closest('.local-setting')) return;
  const res = await request('settings', {
    locked: $('#set-locked').checked,
    waitMode: dialog.querySelector('input[name="waitMode"]:checked')?.value,
    relayEnabled: $('#set-relay').checked,
    relayLimit: Math.max(0, Math.min(10, Number($('#set-relay-limit').value) || 0)),
    relay4k: $('#set-relay4k').checked,
    stopOtherDownloads: $('#set-stop-others').checked,
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
