// Birlikte İzle: Stremio watch-party addon + room server + local control panel.
//   :7000  public  (addon, room pages, Socket.IO, relay)  <- cloudflared tunnel
//   :7001  panel   (GUI, room creation)                   <- 127.0.0.1 only

import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

import { createLogger } from './src/log.js';
import { createConfigStore } from './src/config.js';
import { createAddonsClient } from './src/addons-client.js';
import { createAddonRouter } from './src/addon.js';
import { createStremioLocal } from './src/stremio-local.js';
import { createRoomManager } from './src/rooms.js';
import { attachSocket } from './src/socket.js';
import { createTunnel, installCloudflared } from './src/tunnel.js';
import { createPanelApp } from './src/panel-api.js';
import { createSubtitleService, createSubtitleRouter } from './src/subtitles.js';
import { createRelay } from './src/relay.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT) || 7000;
const PANEL_PORT = Number(process.env.PANEL_PORT) || 7001;
const PUBLIC_BASE = `http://127.0.0.1:${PUBLIC_PORT}`;
const PANEL_BASE = `http://127.0.0.1:${PANEL_PORT}`;

const log = createLogger({ file: path.join(DATA, 'logs', 'server.log') });
const config = createConfigStore(path.join(DATA, 'config.json'), log);
const addons = createAddonsClient();
const stremioLocal = createStremioLocal();
const rooms = createRoomManager();
const subtitles = createSubtitleService({
  addons,
  getAddons: () => config.get().addons,
  stremioLocal,
  log,
});
const relay = createRelay({ rooms, log });

// Filled in once the socket layer exists; HTTP routes use it to push updates.
let socketCtl = null;
const dispatch = (room, msgs) => socketCtl?.dispatch(room, msgs);

function refreshSubtitles(room) {
  subtitles.refresh(room, (msgs) => dispatch(room, msgs)).catch((err) => {
    log.warn('Altyazı listesi alınamadı', { roomId: room.id, error: err.message });
  });
}

// ---- public server (:7000) ------------------------------------------------

const ROOM_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  'media-src * blob:',
  "connect-src 'self' ws: wss: http://127.0.0.1:11470 https://speed.cloudflare.com",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
].join('; ');

const publicApp = express();
publicApp.disable('x-powered-by');
publicApp.set('trust proxy', false);
publicApp.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
publicApp.use(createAddonRouter({ panelBase: PANEL_BASE }));
publicApp.use(createSubtitleRouter({ rooms, service: subtitles, dispatch, log }));
publicApp.use(relay.router);
publicApp.get('/', (req, res) => res.redirect(302, '/room/'));
publicApp.get(['/room', '/room/', '/room/:id'], (req, res) => {
  res.set('Content-Security-Policy', ROOM_CSP);
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(ROOT, 'public', 'room.html'));
});
publicApp.get('/vendor/hls.min.js', (req, res) =>
  res.sendFile(path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js')),
);
publicApp.use(express.static(path.join(ROOT, 'public'), { index: false }));

const publicServer = http.createServer(publicApp);
const io = new Server(publicServer, { maxHttpBufferSize: 100_000, serveClient: true });

let tunnel = null;
socketCtl = attachSocket(io, {
  rooms,
  log,
  getPublicUrl: () => tunnel?.status().url ?? null,
  hooks: {
    onHostStream: refreshSubtitles,
    roomEvents: {
      setHostSubtitle: (room, uid, p) =>
        room.setHostSubtitle(uid, { subId: p.subId ?? null, offset: Number(p.offset ?? 0) }),
      requestRelay: (room, uid) => room.requestRelay(uid),
      releaseRelay: (room, uid) => room.releaseRelay(uid),
    },
  },
});

tunnel = createTunnel({
  port: PUBLIC_PORT,
  log,
  onChange: (s) => {
    if (s.state === 'up') socketCtl.broadcastPublicUrl(s.url);
  },
});

// ---- panel server (:7001) -------------------------------------------------

const panelServer = http.createServer(
  createPanelApp({
    panelKey: crypto.randomBytes(24).toString('hex'),
    panelDir: path.join(ROOT, 'panel'),
    publicBase: PUBLIC_BASE,
    config,
    addons,
    rooms,
    socketCtl,
    tunnel,
    stremioLocal,
    log,
    onShutdown: shutdown,
    installCloudflared: () => installCloudflared({ log }),
    onRoomCreated: refreshSubtitles,
    relayStats: (roomId) => relay.stats(roomId),
  }),
);

// ---- lifecycle ------------------------------------------------------------

function listen(server, port, name) {
  return new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`${port} portu kullanımda. Sunucu zaten çalışıyor olabilir.`);
      } else {
        log.error(`${name} başlatılamadı`, { error: err.message });
      }
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', resolve);
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Sunucu kapatılıyor');
  tunnel.stop();
  socketCtl.stop();
  relay.stop();
  io.close();
  panelServer.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => log.error('Yakalanmamış hata', { error: String(err?.stack || err) }));

await listen(publicServer, PUBLIC_PORT, 'Public sunucu');
await listen(panelServer, PANEL_PORT, 'Panel');
log.info('Birlikte İzle çalışıyor', {
  panel: `${PANEL_BASE}/`,
  eklenti: `${PUBLIC_BASE}/manifest.json`,
});
tunnel.start();
