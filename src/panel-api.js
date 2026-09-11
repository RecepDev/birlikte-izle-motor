// Local-only control panel (GUI) server. Never exposed through the tunnel.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { isContentId, isContentType } from './addon.js';
import { normalizeStreams } from './streams.js';

const STREAM_CACHE_MS = 10 * 60 * 1000;

// Express 4 does not catch rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createPanelApp({
  panelKey,
  panelDir,
  publicBase,
  config,
  addons,
  rooms,
  socketCtl,
  tunnel,
  stremioLocal,
  log,
  onShutdown,
  installCloudflared,
  onRoomCreated = () => {},
  relayStats = () => null,
}) {
  const app = express();
  app.disable('x-powered-by');
  const streamCache = new Map(); // "type|id" -> { at, meta, streams }

  const localHosts = (req) => {
    const port = req.socket.localPort;
    return { hosts: [`127.0.0.1:${port}`, `localhost:${port}`], origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`] };
  };

  // DNS rebinding guard: only answer requests addressed to this machine.
  app.use((req, res, next) => {
    if (!localHosts(req).hosts.includes(req.headers.host)) return res.status(403).send('Forbidden');
    next();
  });

  app.get('/api/ping', (req, res) => res.type('text').send('ok'));

  const page = (file) => (req, res) => {
    const html = fs.readFileSync(path.join(panelDir, file), 'utf8').replaceAll('%%PANEL_KEY%%', panelKey);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'self'; img-src * data:; frame-ancestors 'none'");
    res.type('html').send(html);
  };
  app.get('/', page('index.html'));
  app.get('/new', page('new.html'));
  app.use(express.static(panelDir, { index: false }));

  // Every API call needs the key (custom header also forces a CORS preflight
  // that we never approve). State changes must come from the panel origin.
  app.use('/api', (req, res, next) => {
    if (req.headers['x-panel-key'] !== panelKey) return res.status(401).json({ error: 'Yetkisiz' });
    if (req.method !== 'GET' && !localHosts(req).origins.includes(req.headers.origin)) {
      return res.status(403).json({ error: 'Geçersiz origin' });
    }
    next();
  });
  app.use('/api', express.json({ limit: '100kb' }));

  app.get('/api/status', wrap(async (req, res) => {
    res.json({
      tunnel: tunnel.status(),
      stremio: await stremioLocal.isUp(),
      addonUrl: `${publicBase}/manifest.json`,
    });
  }));

  app.post('/api/tunnel/restart', (req, res) => {
    tunnel.restart();
    res.json({ ok: true });
  });

  app.post('/api/cloudflared/install', (req, res) => {
    installCloudflared().then((code) => {
      if (code === 0) tunnel.start();
    });
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => res.json(config.get()));
  app.put('/api/config', (req, res) => {
    try {
      res.json(config.save(req.body));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/addons/test', async (req, res) => {
    try {
      res.json(await addons.manifest(String(req.body?.url || '')));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  async function loadStreams(type, id) {
    const key = `${type}|${id}`;
    const hit = streamCache.get(key);
    if (hit && Date.now() - hit.at < STREAM_CACHE_MS) return hit;
    const enabled = config.get().addons;
    const [meta, { results, errors }] = await Promise.all([addons.meta(type, id), addons.streams(enabled, type, id)]);
    const entry = { at: Date.now(), meta, streams: normalizeStreams(results), errors };
    streamCache.set(key, entry);
    return entry;
  }

  const validContent = (type, id) => isContentType(type) && typeof id === 'string' && isContentId(id);

  app.get('/api/streams', wrap(async (req, res) => {
    const { type, id } = req.query;
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    streamCache.delete(`${type}|${id}`); // opening the page always refreshes
    const { meta, streams, errors } = await loadStreams(type, id);
    res.json({ meta, streams, errors });
  }));

  app.post('/api/rooms', wrap(async (req, res) => {
    const { type, id, streamId } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    const { meta, streams } = await loadStreams(type, id);
    if (!streams.some((s) => s.streamId === streamId)) return res.status(400).json({ error: 'Stream bulunamadı' });
    const { room, creatorToken } = rooms.create({
      type, contentId: id, meta, streams, hostStreamId: streamId, settings: config.get().defaults,
    });
    log.info('Oda açıldı', { roomId: room.id, content: id });
    onRoomCreated(room);
    res.json({
      roomId: room.id,
      creatorToken,
      roomUrl: `${publicBase}/room/${room.id}#${new URLSearchParams({ host: creatorToken, name: config.get().nickname })}`,
    });
  }));

  app.get('/api/rooms', (req, res) => {
    res.json(rooms.list().map((r) => ({ ...r.summary(), relay: relayStats(r.id) })));
  });

  app.post('/api/rooms/:id/close', (req, res) => {
    if (!socketCtl.closeRoom(req.params.id)) return res.status(404).json({ error: 'Oda yok' });
    log.info('Oda panelden kapatıldı', { roomId: req.params.id });
    res.json({ ok: true });
  });

  app.post('/api/rooms/:id/kick', (req, res) => {
    if (!socketCtl.kickUser(req.params.id, String(req.body?.userId || ''))) {
      return res.status(404).json({ error: 'Oda veya kişi yok' });
    }
    res.json({ ok: true });
  });

  app.get('/api/logs', (req, res) => res.json(log.recent()));

  app.post('/api/shutdown', (req, res) => {
    res.json({ ok: true });
    setTimeout(onShutdown, 200);
  });

  app.use((err, req, res, next) => {
    log.error('Panel isteği hata verdi', { path: req.path, error: err.message });
    res.status(500).json({ error: 'Sunucu hatası' });
  });

  return app;
}
