// Keeps the local <video> aligned with the room's playback state.

import { expectedPosition, estimateClockOffset, driftAction, SEEK_THRESHOLD } from './shared/sync-core.js';

const AUTO_SEEK_COOLDOWN_MS = 4000;
const PROGRAMMATIC_WINDOW_MS = 1000;

export function createSync({ video, request, canControl, onBlocked, onError }) {
  let offset = 0;
  let playback = null;
  let autoPaused = false;
  let lastAutoSeek = 0;
  let drift = null;
  // Events we caused ourselves; anything else is a user action (PiP, media keys, iOS player).
  const programmatic = { play: 0, pause: 0, seeked: 0 };
  // Kendi yaptığımız sarma bitti mi: telefonda "seeked" yeni yer indirilince (saniyeler sonra)
  // geliyor; süreye bakılırsa kişinin sarması sanılıp yeniden sarılıyordu (sonsuz sarma).
  let seekPending = false;

  const serverNow = () => Date.now() + offset;
  const target = () => (playback ? expectedPosition(playback, serverNow()) : 0);
  const hasMedia = () => video.readyState >= 1 && Number.isFinite(video.duration);

  function setTime(t) {
    programmatic.seeked = Date.now();
    seekPending = true;
    video.currentTime = Math.min(t, Math.max(0, (video.duration || t) - 0.5));
  }

  function doPlay() {
    if (!video.paused) return;
    programmatic.play = Date.now();
    video.play().catch((err) => {
      if (err.name === 'NotAllowedError') onBlocked();
    });
  }

  function doPause() {
    if (video.paused) return;
    programmatic.pause = Date.now();
    video.pause();
  }

  function apply() {
    if (!playback || !hasMedia()) return;
    const t = target();
    if (playback.paused) {
      doPause();
      video.playbackRate = 1;
      if (Math.abs(video.currentTime - t) > 0.3) setTime(t);
    } else {
      if (Math.abs(video.currentTime - t) > SEEK_THRESHOLD) {
        lastAutoSeek = Date.now();
        setTime(t);
      }
      doPlay();
    }
  }

  function tick() {
    if (!playback || !hasMedia()) {
      drift = null;
      return;
    }
    const diff = video.currentTime - target();
    drift = Math.round(diff * 1000) / 1000;
    if (playback.paused) {
      doPause();
      return;
    }
    if (video.paused) {
      doPlay();
      return;
    }
    if (video.seeking || video.readyState < 3) return;
    const action = driftAction(diff, video.playbackRate);
    if (action.type === 'seek') {
      if (Date.now() - lastAutoSeek < AUTO_SEEK_COOLDOWN_MS) return;
      lastAutoSeek = Date.now();
      setTime(target());
    } else if (action.type === 'rate') {
      video.playbackRate = action.rate;
    }
  }

  async function send(action, position) {
    const res = await request('control', { action, position });
    if (res?.error) {
      onError(res.error);
      apply();
    }
  }

  const localPosition = () => (hasMedia() ? video.currentTime : target());
  const intendsToPlay = () => Boolean(playback && (!playback.paused || autoPaused));

  function onMediaEvent(kind, action) {
    if (kind === 'seeked' && seekPending) {
      seekPending = false;
      return;
    }
    if (Date.now() - programmatic[kind] < PROGRAMMATIC_WINDOW_MS) return;
    if (!playback || video.ended) return;
    if (!canControl()) {
      apply(); // revert: guests in a locked room follow the host
      return;
    }
    send(action, video.currentTime);
  }

  video.addEventListener('play', () => onMediaEvent('play', 'play'));
  video.addEventListener('pause', () => onMediaEvent('pause', 'pause'));
  video.addEventListener('seeked', () => onMediaEvent('seeked', 'seek'));
  video.addEventListener('loadedmetadata', apply);
  video.addEventListener('canplay', apply);

  const timer = setInterval(tick, 1000);

  return {
    async calibrate() {
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const sent = Date.now();
        const server = await request('time', {});
        const received = Date.now();
        if (typeof server === 'number') samples.push({ sent, received, server });
      }
      offset = estimateClockOffset(samples);
    },
    setPlayback(next, nextAutoPaused) {
      playback = next;
      autoPaused = Boolean(nextAutoPaused);
      apply();
    },
    // The room intends to play (either playing, or paused only to wait for someone).
    intendsToPlay,
    toggle() {
      if (!playback) return;
      send(intendsToPlay() ? 'pause' : 'play', localPosition());
    },
    seek(position) {
      send('seek', position);
    },
    reapply: apply,
    target,
    drift: () => drift,
    stop: () => clearInterval(timer),
  };
}
