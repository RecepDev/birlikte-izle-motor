// "Watch through the host": proxies ONE room's torrent streams from the host
// PC's Stremio to guests without their own Stremio. Everything else on the
// Stremio server stays unreachable.

import http from 'node:http';
import { ACIK_ARALIK, dosyaYolu, ilkIstekMi, parcaliAkit } from './stremio-parca.js';
import express from 'express';
import {
  STREMIO_BASE,
  torrentPath,
  localTorrentUrl,
  hlsConvertId,
  hlsV2Query,
  HLS_VIDEO_CODECS,
  HLS_AUDIO_CODECS,
  HLS_4K_WIDTH,
  COMPAT_WIDTHS,
} from '../public/js/shared/stream-url.js';

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'];
const STATS_EVERY_MS = 2000;

// Paths Stremio's HLS converter serves under /hlsv2/<id>/.
const HLSV2_TAIL = /^(?:(?:master|video\d+|audio\d+|subtitle\d+)\.m3u8|(?:video|audio)\d+\/init\.mp4|(?:video|audio|subtitle)\d+\/segment\d+\.(?:m4s|vtt))$/;
const HLSV2_KEYS = new Set(['mediaURL', 'videoCodecs', 'audioCodecs', 'maxWidth']);

// Accepts a converter request only when it is exactly the one this app would
// build for a torrent in this room. 4K conversion (maxWidth) loads the host
// PC, so it needs allow4k. Returns { stream, query } or null.
export function validateHlsV2(room, convertId, tail, rawQuery, stremioBase = STREMIO_BASE, { allow4k = false } = {}) {
  if (!HLSV2_TAIL.test(tail || '')) return null;
  const q = new URLSearchParams(rawQuery);
  for (const k of q.keys()) if (!HLSV2_KEYS.has(k)) return null;
  const media = q.getAll('mediaURL');
  if (media.length !== 1) return null;
  let u;
  try {
    u = new URL(media[0]);
  } catch {
    return null;
  }
  if (u.origin !== new URL(stremioBase).origin) return null;
  const m = u.pathname.match(/^\/([0-9a-f]{40})\/(-1|\d+)$/);
  if (!m) return null;
  for (const k of u.searchParams.keys()) if (k !== 'tr' && k !== 'f') return null;
  const stream = room.streams.find(
    (s) => s.kind === 'torrent' && s.infoHash === m[1] && torrentPath(s) === `/${m[1]}/${m[2]}`,
  );
  if (!stream) return null;
  // Any resolution tier from the picker is fine (720p/480p only ever reduce
  // load); only the 2160p one needs allow4k, since that's the one that costs
  // the converting Stremio real CPU/bandwidth.
  const maxWidth = q.getAll('maxWidth');
  if (maxWidth.length > 1) return null;
  const width = maxWidth.length ? Number(maxWidth[0]) : null;
  if (width !== null) {
    if (!Object.values(COMPAT_WIDTHS).includes(width)) return null;
    if (width === HLS_4K_WIDTH && !allow4k) return null;
  }
  const caps = { videoCodecs: q.getAll('videoCodecs'), audioCodecs: q.getAll('audioCodecs') };
  if (width !== null) caps.maxWidth = width;
  if (!caps.videoCodecs.length || !caps.videoCodecs.every((c) => HLS_VIDEO_CODECS.includes(c))) return null;
  if (!caps.audioCodecs.length || !caps.audioCodecs.every((c) => HLS_AUDIO_CODECS.includes(c))) return null;
  if (convertId !== hlsConvertId(stream, caps)) return null;
  return { stream, query: hlsV2Query(stream, caps, stremioBase).toString() };
}

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

  // Registers the torrent with its trackers before the converter opens it.
  function warmTorrent(stream) {
    const req = http.get(localTorrentUrl(stream, stremioBase), { headers: { range: 'bytes=0-0' } }, (r) => r.resume());
    req.on('error', () => {});
    req.setTimeout(10_000, () => req.destroy());
  }

  // Common room/key check; returns { room, user } or ends the response.
  function authorize(req, res) {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).end();
      return null;
    }
    const user = room.findRelayUser(req.params.key);
    if (!user) {
      res.status(403).end();
      return null;
    }
    return { room, user };
  }

  function proxy(req, res, { room, user, target, rewrite = null }) {
    // Torrent dosyası, ucu açık aralık: Stremio'ya kapalı parçalarla sor (birikme olmasın).
    const yol = new URL(target).pathname;
    const aralik = req.headers.range;
    const acik = aralik && ACIK_ARALIK.exec(aralik);
    if (req.method !== 'HEAD' && dosyaYolu(yol) && (!aralik || acik) && !ilkIstekMi(yol)) {
      parcaliAkit(target, acik ? Number(acik[1]) : 0, Boolean(acik), res, { onBytes: (n) => count(room, user, n) })
        .catch((err) => {
          log.warn('Relay isteği başarısız', { roomId: room.id, error: err.message });
          if (!res.headersSent) res.status(502).end();
          else res.destroy();
        });
      return;
    }
    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    if (req.headers.accept) headers.accept = req.headers.accept;

    const upstream = http.request(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, (up) => {
      const isPlaylist = /mpegurl/i.test(String(up.headers['content-type'] || '')) || new URL(target).pathname.endsWith('.m3u8');
      res.status(up.statusCode || 502);
      for (const h of PASS_HEADERS) {
        if (up.headers[h] && !(isPlaylist && h === 'content-length')) res.setHeader(h, up.headers[h]);
      }
      if (isPlaylist && rewrite) {
        let text = '';
        up.setEncoding('utf8');
        up.on('data', (chunk) => { text += chunk; });
        up.on('end', () => {
          const body = rewrite(text);
          count(room, user, Buffer.byteLength(body));
          res.end(body);
        });
        return;
      }
      up.on('data', (chunk) => count(room, user, chunk.length));
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      log.warn('Relay isteği başarısız', { roomId: room.id, error: err.message });
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    res.on('close', () => upstream.destroy());
    upstream.end();
  }

  // Lets a guest check that the host's Stremio is running before playing.
  router.get('/relay/:roomId/:key/ping', (req, res) => {
    if (!authorize(req, res)) return;
    const probe = http.get(`${stremioBase}/settings`, (r) => {
      r.resume();
      res.status(r.statusCode === 200 ? 200 : 503).end();
    });
    probe.setTimeout(2000, () => probe.destroy(new Error('timeout')));
    probe.on('error', () => {
      if (!res.headersSent) res.status(503).end();
    });
  });

  // Plain file of a room torrent (trackers come from the server's stream record).
  router.get('/relay/:roomId/:key/:infoHash([0-9a-f]{40})/:fileIdx(-1|\\d+)', (req, res) => {
    const auth = authorize(req, res);
    if (!auth) return;
    const { infoHash, fileIdx } = req.params;
    const stream = auth.room.streams.find(
      (s) => s.kind === 'torrent' && s.infoHash === infoHash && torrentPath(s) === `/${infoHash}/${fileIdx}`,
    );
    if (!stream) return res.status(403).end();
    proxy(req, res, { ...auth, target: localTorrentUrl(stream, stremioBase) });
  });

  // Compatibility mode: Stremio's HLS converter, only for room torrents.
  router.get('/relay/:roomId/:key/hlsv2/:convertId/*', (req, res) => {
    const auth = authorize(req, res);
    if (!auth) return;
    const tail = req.params[0];
    const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    // The host converts on its own PC anyway; guests need the host's permission.
    const allow4k = auth.user.id === auth.room.hostUserId || auth.room.settings.relay4k === true;
    const ok = validateHlsV2(auth.room, req.params.convertId, tail, rawQuery, stremioBase, { allow4k });
    if (!ok) return res.status(403).end();
    if (tail === 'master.m3u8') warmTorrent(ok.stream);
    const prefix = `/relay/${req.params.roomId}/${req.params.key}/hlsv2/`;
    proxy(req, res, {
      ...auth,
      target: `${stremioBase}/hlsv2/${req.params.convertId}/${tail}?${ok.query}`,
      // Playlists use relative paths; rewrite absolute ones just in case.
      rewrite: (text) => text.split(`${stremioBase}/hlsv2/`).join(prefix),
    });
  });

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
