// Server-side calls to the host PC's own Stremio streaming server.
// (Browsers cannot read these responses: Stremio only allows its own origins.)

import { STREMIO_BASE, torrentPath, localTorrentUrl } from '../public/js/shared/stream-url.js';

export function createStremioLocal({ base = STREMIO_BASE, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  // Live torrent stats from the host's Stremio; null when it has not opened the torrent.
  async function fetchStats(stream) {
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
  }

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

    torrentStats: fetchStats,

    // Starts the torrent (same trick the relay uses to warm one before converting)
    // and polls its stats for a few seconds: a torrent that shows peers but never
    // actually downloads anything looks the same as a healthy one until you try it,
    // this lets the host check before picking it for the room.
    async checkTorrent(stream, { checkMs = 7000, pollMs = 1000 } = {}) {
      const warm = fetchImpl(localTorrentUrl(stream, base), {
        headers: { range: 'bytes=0-1' },
        signal: AbortSignal.timeout(checkMs + 2000),
      }).catch(() => {});
      const deadline = Date.now() + checkMs;
      const best = { peers: 0, downMbps: 0 };
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const s = await fetchStats(stream);
        if (s) {
          best.peers = Math.max(best.peers, s.peers);
          best.downMbps = Math.max(best.downMbps, s.downMbps);
          if (best.downMbps > 0.1) break; // clearly alive, no need to wait out the full window
        }
      }
      await warm;
      // Peers alone prove nothing (that's the whole complaint: some torrents show
      // peers but never actually feed data) — only real download speed counts.
      return { ...best, alive: best.downMbps > 0.1 };
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
