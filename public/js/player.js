// Chooses where the video comes from and reports the local playback state.
//
// States: idle | loading | ready | buffering | error | noStremio
// Sources: local (own Stremio) | relay (host PC) | http | none

import { STREMIO_BASE, localTorrentUrl } from './shared/stream-url.js';

const BUFFER_DEBOUNCE_MS = 1000;
const LOAD_TIMEOUT_MS = 60_000;
const PROBE_RETRY_MS = 3000;

export async function isStremioUp() {
  try {
    // no-cors: Stremio does not send CORS headers to us, but an opaque
    // response still proves the server answered.
    await fetch(`${STREMIO_BASE}/settings`, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

export function createPlayer({ video, onStatus, resolveFallback = async () => null, attachSource = null }) {
  let status = { state: 'idle', source: 'none' };
  let stream = null;
  let generation = 0;
  let bufferTimer = null;
  let loadTimer = null;
  let retryTimer = null;
  let lastError = null;
  let attached = false;
  // Önü azalınca (takılmadan önce) "yükleniyor" say: oda durup bekliyor (bkz. room.js).
  let held = false;

  function set(state, source = status.source) {
    if (status.state === state && status.source === source) return;
    status = { state, source };
    onStatus({ ...status });
  }

  function clearTimers() {
    clearTimeout(bufferTimer);
    bufferTimer = null;
    clearTimeout(loadTimer);
    clearTimeout(retryTimer);
  }

  function detach() {
    attached = false;
    if (attachSource) attachSource(null);
    video.removeAttribute('src');
    video.load();
  }

  function attach(url, source, opts = {}) {
    lastError = null;
    attached = true;
    set('loading', source);
    if (attachSource && attachSource(url, opts)) {
      // handled by an external engine (hls.js)
    } else {
      video.src = url;
      video.load();
    }
    loadTimer = setTimeout(() => {
      if (status.state === 'loading') {
        lastError = 'timeout';
        set('error');
      }
    }, LOAD_TIMEOUT_MS);
  }

  async function load(next, opts = {}) {
    const gen = ++generation;
    held = false;
    stream = next;
    clearTimers();
    if (!next) {
      detach();
      set('idle', 'none');
      return;
    }
    if (next.kind === 'http' && !opts.forceFallback) {
      attach(next.url, 'http', opts);
      return;
    }
    if (next.kind === 'torrent' && !opts.forceFallback && (await isStremioUp())) {
      if (gen !== generation) return;
      attach(localTorrentUrl(next), 'local', opts);
      return;
    }
    const fallback = await resolveFallback(next, opts);
    if (gen !== generation) return;
    if (fallback) {
      attach(fallback.url, fallback.source, { ...opts, ...fallback });
      return;
    }
    detach();
    if (opts.compat) {
      lastError = 'compat';
      set('error', 'none');
      return;
    }
    set('noStremio', 'none');
    retryTimer = setTimeout(() => {
      if (gen === generation) load(stream, opts);
    }, PROBE_RETRY_MS);
  }

  function markReady() {
    clearTimeout(bufferTimer);
    bufferTimer = null;
    clearTimeout(loadTimer);
    if (held && status.state !== 'loading') return;
    if (status.state !== 'error' && status.state !== 'idle' && status.state !== 'noStremio') set('ready');
  }

  video.addEventListener('canplay', markReady);
  video.addEventListener('playing', markReady);
  video.addEventListener('seeked', () => {
    if (video.readyState >= 3) markReady();
  });
  // Telefon/masaüstü köprüsü takıldığı sürece "waiting"i sık sık (0,2 sn) yolluyor: sayaç her
  // seferinde baştan başlarsa hiç dolmuyor, kişi "yükleniyor" olmuyor ve oda onu beklemiyordu.
  // Sayaç yalnızca ilk "waiting"te kuruluyor.
  video.addEventListener('waiting', () => {
    if (bufferTimer) return;
    bufferTimer = setTimeout(() => {
      bufferTimer = null;
      if (video.readyState < 3 && status.state === 'ready') set('buffering');
    }, BUFFER_DEBOUNCE_MS);
  });
  video.addEventListener('error', () => {
    if (!attached) return;
    const code = video.error?.code;
    lastError = code === 4 ? 'unsupported' : code === 3 ? 'decode' : 'network';
    clearTimers();
    set('error');
  });

  // Safety net for missed media events.
  setInterval(() => {
    if ((status.state === 'buffering' || status.state === 'loading') && video.readyState >= 3) markReady();
  }, 1000);

  return {
    load,
    hold(on) {
      if (held === on) return;
      held = on;
      if (on && status.state === 'ready') set('buffering');
      else if (!on && status.state === 'buffering' && video.readyState >= 3) markReady();
    },
    held: () => held,
    reload: (opts) => load(stream, opts),
    status: () => ({ ...status }),
    stream: () => stream,
    lastError: () => lastError,
    duration: () => (Number.isFinite(video.duration) ? video.duration : null),
    fail(reason) {
      lastError = reason;
      clearTimers();
      set('error');
    },
  };
}
