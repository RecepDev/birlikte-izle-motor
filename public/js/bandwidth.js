// Bitrate a file needs.

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
    // Uygulama köprüleri (mpv/ExoPlayer) currentSrc vermiyor, src veriyor.
    if (!(video.currentSrc || video.src) || video.readyState < 1) return reset();
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
