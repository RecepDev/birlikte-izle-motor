// Bitrate a file needs, and an on-demand internet download speed test.

const SPEEDTEST_URL = 'https://speed.cloudflare.com/__down?bytes=';

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

// Live download estimate. Stremio's own stats are not readable cross-origin,
// so: seconds of video buffered per second x the file's bitrate.
export function createDownloadMeter(video, getBitrateMbps, windowMs = 6000) {
  let samples = [];
  const reset = () => { samples = []; };
  video.addEventListener('seeking', reset);
  video.addEventListener('emptied', reset);
  setInterval(() => {
    if (!video.currentSrc || video.readyState < 1) return reset();
    const now = performance.now();
    samples.push({ t: now, end: bufferedAhead(video).end });
    samples = samples.filter((s) => now - s.t <= windowMs);
  }, 1000);

  return {
    read() {
      const { end, ahead } = bufferedAhead(video);
      const complete = Number.isFinite(video.duration) && end >= video.duration - 1;
      if (complete || samples.length < 3) return { mbps: null, ahead, complete };
      const first = samples[0];
      const last = samples[samples.length - 1];
      const rate = Math.max(0, (last.end - first.end) / ((last.t - first.t) / 1000));
      const bitrate = getBitrateMbps();
      return { mbps: bitrate ? rate * bitrate : null, ahead, complete };
    },
  };
}

const toMbps = (bytes, ms) => (ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0);

// Downloads from Cloudflare for up to maxMs and returns the measured Mbps.
export async function runSpeedTest({ onProgress = () => {}, maxMs = 10_000, bytes = 100_000_000 } = {}) {
  const ctrl = new AbortController();
  const hardStop = setTimeout(() => ctrl.abort(), maxMs + 8000);
  let received = 0;
  let start = 0;
  try {
    const res = await fetch(`${SPEEDTEST_URL}${bytes}`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    start = performance.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      const elapsed = performance.now() - start;
      onProgress(toMbps(received, elapsed));
      if (elapsed >= maxMs) {
        ctrl.abort();
        break;
      }
    }
  } catch (err) {
    if (!received) throw err;
  } finally {
    clearTimeout(hardStop);
  }
  return toMbps(received, performance.now() - start);
}
