// "Watch through the host": proxies ONE room's torrent streams from the host
// PC's Stremio to guests without their own Stremio. Everything else on the
// Stremio server stays unreachable.

import http from 'node:http';
import express from 'express';
import { STREMIO_BASE, torrentPath, localTorrentUrl } from '../public/js/shared/stream-url.js';

// Sub-paths Stremio's HLS transcoder uses under /<infoHash>/<fileIdx>/.
const HLS_TAIL = /^(hls\.m3u8|(video|audio|subtitle)\d+(\.m3u8)?(\/(init\.mp4|segment\d+\.(m4s|vtt)))?)$/;
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
const STATS_EVERY_MS = 2000;

export function createRelay({ rooms, stremioBase = STREMIO_BASE, log }) {
  const router = express.Router();
  const counters = new Map(); // `${roomId}|${userId}` -> { roomId, userId, name, bytes, lastBytes, mbps }

  function count(room, user, n) {
    const key = `${room.id}|${user.id}`;
    let c = counters.get(key);
    if (!c) {
      c = { roomId: room.id, userId: user.id, name: user.name, bytes: 0, lastBytes: 0, mbps: 0 };
      counters.set(key, c);
    }
    c.bytes += n;
  }

  const timer = setInterval(() => {
    for (const [key, c] of counters) {
      c.mbps = ((c.bytes - c.lastBytes) * 8) / 1e6 / (STATS_EVERY_MS / 1000);
      c.lastBytes = c.bytes;
      if (!rooms.get(c.roomId)) counters.delete(key);
    }
  }, STATS_EVERY_MS);
  timer.unref?.();

  function handle(req, res) {
    const { roomId, key, infoHash, fileIdx } = req.params;
    const tail = req.params[0];
    const room = rooms.get(roomId);
    if (!room) return res.status(404).end();
    if (tail !== undefined && !HLS_TAIL.test(tail)) return res.status(404).end();
    const user = room.findRelayUser(key);
    if (!user) return res.status(403).end();
    const stream = room.streams.find(
      (s) => s.kind === 'torrent' && s.infoHash === infoHash && torrentPath(s) === `/${infoHash}/${fileIdx}`,
    );
    if (!stream) return res.status(403).end();

    const target = tail === undefined ? localTorrentUrl(stream, stremioBase) : `${stremioBase}${torrentPath(stream)}/${tail}`;
    const relayPrefix = `/relay/${roomId}/${key}${torrentPath(stream)}`;
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    if (req.headers.accept) headers.accept = req.headers.accept;

    const upstream = http.request(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, (up) => {
      const type = String(up.headers['content-type'] || '');
      const isPlaylist = /mpegurl/i.test(type) || tail?.endsWith('.m3u8');
      res.status(up.statusCode || 502);
      for (const h of PASS_HEADERS) {
        if (up.headers[h] && !(isPlaylist && h === 'content-length')) res.setHeader(h, up.headers[h]);
      }
      if (isPlaylist) {
        // Playlists normally use relative paths; rewrite absolute ones just in case.
        let text = '';
        up.setEncoding('utf8');
        up.on('data', (chunk) => { text += chunk; });
        up.on('end', () => {
          const body = text.split(`${stremioBase}${torrentPath(stream)}`).join(relayPrefix);
          count(room, user, Buffer.byteLength(body));
          res.end(body);
        });
        return;
      }
      up.on('data', (chunk) => count(room, user, chunk.length));
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      log.warn('Relay isteği başarısız', { roomId, error: err.message });
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  }

  router.get('/relay/:roomId/:key/:infoHash([0-9a-f]{40})/:fileIdx(-1|\\d+)', handle);
  router.get('/relay/:roomId/:key/:infoHash([0-9a-f]{40})/:fileIdx(-1|\\d+)/*', handle);

  return {
    router,
    stats(roomId) {
      const users = [...counters.values()]
        .filter((c) => c.roomId === roomId)
        .map(({ userId, name, bytes, mbps }) => ({ userId, name, bytes, mbps: Math.round(mbps * 10) / 10 }));
      return { users, totalMbps: Math.round(users.reduce((s, u) => s + u.mbps, 0) * 10) / 10 };
    },
    stop: () => clearInterval(timer),
  };
}
