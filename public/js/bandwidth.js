// Estimates whether the download keeps up with playback.
//
// The page cannot read Stremio's own stats (no CORS), so we measure what
// matters directly: how many seconds of video get buffered per second of
// wall time. A rate below 1 means the download cannot keep up.

const WINDOW_MS = 20_000;
const MIN_WINDOW_MS = 12_000;
const WARMUP_MS = 30_000;
const SATURATED_AHEAD_S = 120; // browsers stop fetching once this much is buffered

export function requiredMbps(sizeBytes, durationSec) {
  if (!Number.isFinite(sizeBytes) || !Number.isFinite(durationSec) || sizeBytes <= 0 || durationSec <= 0) return null;
  return (sizeBytes * 8) / durationSec / 1e6;
}

export function bufferedAhead(video) {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.5 && video.buffered.end(i) >= t) {
      return { end: video.buffered.end(i), ahead: video.buffered.end(i) - t };
    }
  }
  return { end: t, ahead: 0 };
}

export function createBandwidthMeter(video) {
  let samples = [];
  let attachedAt = performance.now();

  const reset = () => { samples = []; };
  video.addEventListener('seeking', reset);
  video.addEventListener('emptied', () => {
    reset();
    attachedAt = performance.now();
  });

  setInterval(() => {
    if (!video.currentSrc || video.readyState < 1 || video.ended) return reset();
    const { end, ahead } = bufferedAhead(video);
    const now = performance.now();
    samples.push({ t: now, end, ahead });
    samples = samples.filter((s) => now - s.t <= WINDOW_MS);
  }, 1000);

  return {
    // Seconds of video downloaded per second, or null when we cannot tell yet.
    rate() {
      if (performance.now() - attachedAt < WARMUP_MS || samples.length < 2) return null;
      const first = samples[0];
      const last = samples[samples.length - 1];
      if (last.t - first.t < MIN_WINDOW_MS) return null;
      if (samples.some((s) => s.ahead >= SATURATED_AHEAD_S)) return null;
      if (Number.isFinite(video.duration) && last.end >= video.duration - 1) return null; // fully buffered
      return Math.max(0, (last.end - first.end) / ((last.t - first.t) / 1000));
    },
    ahead: () => bufferedAhead(video).ahead,
  };
}
