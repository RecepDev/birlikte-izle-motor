// Server-side calls to the host PC's own Stremio streaming server.
// (Browsers cannot read these responses: Stremio only allows its own origins.)

import { STREMIO_BASE, torrentPath } from '../public/js/shared/stream-url.js';

export function createStremioLocal({ base = STREMIO_BASE, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  return {
    base,
    async isUp() {
      try {
        const res = await fetchImpl(`${base}/settings`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
      } catch {
        return false;
      }
    },

    // Live torrent stats from the host's Stremio; null when it has not opened the torrent.
    async torrentStats(stream) {
      try {
        const res = await fetchImpl(`${base}${torrentPath(stream)}/stats.json`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        const s = await res.json();
        if (!s) return null;
        return {
          peers: Number(s.peers) || 0,
          downMbps: Math.round(((Number(s.downloadSpeed) || 0) * 8) / 1e5) / 10,
          progress: Number.isFinite(s.streamProgress) ? Math.round(s.streamProgress * 1000) / 1000 : null,
        };
      } catch {
        return null;
      }
    },

    // OpenSubtitles hash of a video the host's Stremio can reach.
    async opensubHash(videoUrl) {
      try {
        const res = await fetchImpl(`${base}/opensubHash?videoUrl=${encodeURIComponent(videoUrl)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return null;
        const { result } = await res.json();
        return result?.hash ? { hash: String(result.hash), size: Number(result.size) } : null;
      } catch {
        return null;
      }
    },
  };
}
