// Bitrate a file needs, and an on-demand internet download speed test.

const SPEEDTEST_URL = 'https://speed.cloudflare.com/__down?bytes=';

export function requiredMbps(sizeBytes, durationSec) {
  if (!Number.isFinite(sizeBytes) || !Number.isFinite(durationSec) || sizeBytes <= 0 || durationSec <= 0) return null;
  return (sizeBytes * 8) / durationSec / 1e6;
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
