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
import { STREMIO_BASE, torrentPath, hlsV2Path, HLS_4K_WIDTH, HLS_VIDEO_CODECS, COMPAT_WIDTHS } from './shared/stream-url.js';
import { langLabel } from './shared/subtitle-text.js';
import { browserCodecs, isRealSafari } from './codecs.js';
import { checkHardware, gpuName, HW_HELP } from './hwaccel.js';

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
  hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => subs?.rerender());
  hls.on(window.Hls.Events.AUDIO_TRACK_SWITCHED, () => subs?.rerender());
  hls.loadSource(url);
  hls.attachMedia(video);
  return true;
}

// Multi-audio files: hls.js exposes alternate audio renditions (compat mode);
// native playback exposes them via the browser's own AudioTrackList when the
// container/browser support it (Safari's native HLS, some local mp4/webm).
if ('audioTracks' in video) {
  const onAudioChange = () => subs?.rerender();
  video.audioTracks.addEventListener('addtrack', onAudioChange);
  video.audioTracks.addEventListener('removetrack', onAudioChange);
  video.audioTracks.addEventListener('change', onAudioChange);
}

function audioTracksList() {
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
  const compat = (Boolean(s?.notWebReady) || audioNeedsReencode(s)) && !(keepQuality && videoNeedsReencode(s));
  loaded = { streamId: id, compat };
  mediaProblem = null;
  reencodeAllowed = false;
  // Known undecodable picture in quality mode: ask before downloading anything.
  qualityBlocked = Boolean(s) && keepQuality && videoNeedsReencode(s);
  player.load(qualityBlocked ? null : s, compat ? { forceFallback: true, compat: true } : {});
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
  return {
    downMbps: r.mbps === null ? null : Math.round(r.mbps * 10) / 10,
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

function speedLabel(st, ts = null) {
  if (st.source === 'none' || st.state === 'noStremio' || st.state === 'idle') return '';
  const parts = [];
  if (st.complete) parts.push('tamamı indi');
  else {
    const down = ts ? ts.downMbps : st.downMbps;
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
      el('span', { class: 'sp', text: speedLabel(st, ts) }));
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
  compatActive: () => loaded.compat,
  onSwitchCompat: () => startCompat(),
  reencodeBlocked: () => qualityBlocked && Boolean(myStream()?.multiAudio),
  onForceCompat: () => startCompat({ allowReencode: true }),
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
    statsFor: (u) => hostPcStats(u),
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
function pictureVerdict(s) {
  const v = pictureVerdictBase(s);
  const items = [{ icon: v.ok ? '✅' : '⚠️', text: v.text.replace(/^(✅|⚠️)\s*/, '') }];
  if (s.hdr) items.push({ icon: '🌗', text: `${s.hdr}: HDR olmayan ekranda karanlık ya da soluk görünebilir (parlaklık ayarı yukarıda).` });
  if (s.embeddedSubs) items.push({ icon: '💬', text: embeddedSubsText(s) });
  if (s.audioRisk) {
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
    pictureFor: (s) => pictureVerdict(s),
  });
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
  renderViewersOverlay();
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

async function openEpisodePicker(series) {
  const box = $('#search-results');
  box.replaceChildren(el('li', { class: 'muted', text: 'Bölümler yükleniyor…' }));
  const res = await request('seriesEpisodes', { id: series.id });
  if (res?.error) {
    toast(errorText(res.error));
    return renderSearchResults(lastSearchResults);
  }
  const bySeason = new Map();
  for (const ep of res.episodes) {
    if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
    bySeason.get(ep.season).push(ep);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  let currentSeason = seasons.find((s) => s !== 0) ?? seasons[0];

  const back = el('button', { type: 'button', class: 'search-back', text: `◀ ${series.name}` });
  back.addEventListener('click', () => renderSearchResults(lastSearchResults));
  const seasonTabs = el('div', { class: 'season-tabs' });
  const list = el('ul', { class: 'search-results' });

  function renderEpisodes() {
    for (const b of seasonTabs.children) b.classList.toggle('active', Number(b.dataset.season) === currentSeason);
    list.replaceChildren(...bySeason.get(currentSeason).map((ep) => {
      const item = el(
        'li',
        {},
        el('div', { class: 'info' },
          el('div', { class: 'name', text: `${ep.episode}. ${ep.name}` }),
          el('div', { class: 'year', text: currentSeason === 0 ? 'Özel' : `Sezon ${currentSeason}` })),
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
    box.replaceChildren(el('li', { class: 'muted', text: $('#search-input').value.trim() ? 'Sonuç yok.' : 'Aramak için yaz.' }));
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
async function runSearch() {
  const q = $('#search-input').value.trim();
  const seq = ++searchSeq;
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
checkHardware().then((result) => {
  hw = result;
  renderHw();
  if (!hw.gpu) toast('Tarayıcında donanım hızlandırma kapalı görünüyor. Ayrıntı: Kalite sekmesi.', 7000);
  renderNotice();
});

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
  toast(`Görüntü oranı: ${ASPECTS.find(([m]) => m === aspectMode)[1]}`, 1500);
});
new ResizeObserver(fitVideo).observe(playerEl);
video.addEventListener('loadedmetadata', fitVideo);
video.addEventListener('resize', fitVideo);
video.addEventListener('emptied', fitVideo);

// Info icons: hover shows the text (title); tap/click shows it too (touch screens).
document.addEventListener('click', (e) => {
  const icon = e.target.closest('.info-i');
  if (!icon?.title) return;
  e.preventDefault();
  toast(icon.title, 7000);
});

// HDR on an SDR screen often looks dark: point to the brightness control once per stream.
let hdrHintFor = null;
video.addEventListener('loadedmetadata', () => {
  const s = myStream();
  if (s?.hdr && pic.b === 1 && pic.s === 1 && hdrHintFor !== s.streamId) {
    hdrHintFor = s.streamId;
    toast(`${s.hdr} video: görüntü karanlıksa Kalite sekmesinden parlaklığı artırabilirsin.`, 8000);
  }
});

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
// Tapping the picture-info box itself also collapses it: on phones it sits over
// the video and blocks it until dismissed.
$('#picture-info').addEventListener('click', toggleViewersOv);
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
  $('#set-relay4k').checked = Boolean(s.relay4k);
  dialog.showModal();
});
dialog.addEventListener('change', async () => {
  const res = await request('settings', {
    locked: $('#set-locked').checked,
    waitMode: dialog.querySelector('input[name="waitMode"]:checked')?.value,
    relayEnabled: $('#set-relay').checked,
    relayLimit: Math.max(0, Math.min(10, Number($('#set-relay-limit').value) || 0)),
    relay4k: $('#set-relay4k').checked,
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
