// Server-side calls to the host PC's own Stremio streaming server.
// (Browsers cannot read these responses: Stremio only allows its own origins.)

import { STREMIO_BASE, torrentPath, localTorrentUrl } from '../public/js/shared/stream-url.js';

const REMOVE_GAP_MS = 20_000;

export function createStremioLocal({ base = STREMIO_BASE, fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const kapatilan = new Map(); // infoHash -> son kapatma isteği
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

    // infoHashes of every torrent currently open in the host's Stremio.
    async openTorrents() {
      try {
        const res = await fetchImpl(`${base}/stats.json`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return [];
        return Object.keys((await res.json()) || {});
      } catch {
        return [];
      }
    },

    // Closes the torrent in the host's Stremio. Stremio never closes one on its own, so
    // every torrent a check opens would otherwise keep downloading in the background.
    // Aynı torrent'i kısa aralıkla iki kez kapatma: Stremio'nun dosya deposu ikinci kapatmada
    // fs.close(null) çağırıp çöküyor ("The streaming server exited", ERR_INVALID_ARG_TYPE).
    // Oda açılınca birden çok temizleyici aynı torrent'i aynı anda kapatıyordu.
    async removeTorrent(stream) {
      const h = stream?.infoHash;
      const once = kapatilan.get(h);
      if (once && Date.now() - once < REMOVE_GAP_MS) return true;
      kapatilan.set(h, Date.now());
      for (const [k, t] of kapatilan) if (Date.now() - t > REMOVE_GAP_MS) kapatilan.delete(k);
      try {
        const res = await fetchImpl(`${base}/${stream.infoHash}/remove`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
      } catch {
        return false;
      }
    },

    // Starts the torrent (same trick the relay uses to warm one before converting)
    // and polls its stats for a few seconds: a torrent that shows peers but never
    // actually downloads anything looks the same as a healthy one until you try it,
    // this lets the host check before picking it for the room.
    // Cold torrents (no cached metadata/peers yet) can take a while to ramp up —
    // real playback gives one up to 60s (see player.js's LOAD_TIMEOUT_MS) before
    // calling it dead, so a much shorter window here was reporting healthy
    // torrents as "no data" just because they hadn't warmed up yet.
    async checkTorrent(stream, { checkMs = 20_000, pollMs = 1000 } = {}) {
      const warm = fetchImpl(localTorrentUrl(stream, base), {
        headers: { range: 'bytes=0-1' },
        signal: AbortSignal.timeout(checkMs + 2000),
      }).catch(() => {});
      const deadline = Date.now() + checkMs;
      const best = { peers: 0, downMbps: 0, progress: 0 };
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        const s = await fetchStats(stream);
        if (s) {
          best.peers = Math.max(best.peers, s.peers);
          best.downMbps = Math.max(best.downMbps, s.downMbps);
          if (s.progress !== null) best.progress = Math.max(best.progress, s.progress);
          // Clearly alive: either it's actively downloading, or it's already
          // sitting on disk from a previous run (nothing left to download, so
          // downloadSpeed can legitimately stay 0 forever).
          if (best.downMbps > 0.1 || best.progress >= 0.99) break;
        }
      }
      await warm;
      // Peers alone prove nothing (that's the whole complaint: some torrents show
      // peers but never actually feed data) — only real download speed or an
      // already-cached file counts.
      return { peers: best.peers, downMbps: best.downMbps, alive: best.downMbps > 0.1 || best.progress >= 0.99 };
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
