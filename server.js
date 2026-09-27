// Birlikte İzle: Stremio watch-party addon + room server + local control panel.
//   :7000  public  (addon, room pages, Socket.IO, relay)  <- cloudflared tunnel
//   :7001  panel   (GUI, room creation)                   <- 127.0.0.1 only

import http from 'node:http';
import dns from 'node:dns';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';

import { createLogger } from './src/log.js';
import { createConfigStore } from './src/config.js';
import { createAddonsClient } from './src/addons-client.js';
import { createAddonRouter, isContentType, isContentId } from './src/addon.js';
import { normalizeStreams, normalizeAddonStreams } from './src/streams.js';
import { parseMagnet } from './src/magnet.js';
import { createStremioLocal } from './src/stremio-local.js';
import { createStremioRestarter, stremioAcikDegilseAc } from './src/stremio-restart.js';
import { createIndirRouter } from './src/indir.js';
import { createGecmis } from './src/gecmis.js';
import { createRoomManager } from './src/rooms.js';
import { attachSocket } from './src/socket.js';
import { createTunnel, installCloudflared } from './src/tunnel.js';
import { createPanelApp } from './src/panel-api.js';
import { createSubtitleService, createSubtitleRouter } from './src/subtitles.js';
import { createRelay } from './src/relay.js';

// Addons like Torrentio resolve to IPv6 first; a flaky IPv6 route shows up as
// "fetch failed", so try IPv4 first.
dns.setDefaultResultOrder('ipv4first');

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
const stremioRestarter = createStremioRestarter({ stremioLocal, log });
// Sunucu açılınca Stremio kapalıysa kendiliğinden aç: oda açmak için onun yayın sunucusu lazım.
stremioAcikDegilseAc({ stremioLocal, log });
// Otomatik yeniden başlatmalar arası en az süre: takılma sürerse döngüye girmesin.
const AUTO_RESTART_COOLDOWN_MS = 5 * 60_000;
// Birisi bekliyorken host'un torrent'i bu kadar süre hiç veri indirmezse Stremio takılmış sayılır.
const STALL_MS = 45_000;
let lastAutoRestart = 0;
// infoHash -> tests running right now. Several files of one torrent share a Stremio torrent,
// so it may only be closed once the last of them has finished.
const activeChecks = new Map();
const rooms = createRoomManager();
const gecmis = createGecmis({ file: path.join(DATA, 'gecmis.json'), log });
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
publicApp.use(createIndirRouter({ root: ROOT, log }));
// Uygulamaların açılış ekranı: şu an açık odalar (misafir de görebiliyor, girebiliyor).
// Tünel adresi yalnızca linki paylaştığın kişilerde olduğu için liste de onlarda.
publicApp.get('/odalar.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  res.json(rooms.list().map((room) => ({
    id: room.id,
    name: room.meta?.name || room.contentId,
    poster: room.meta?.poster || null,
    users: room.connectedUsers().length,
    playing: !room.playback?.paused,
  })));
});
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
      refreshSubtitles: (room) => {
        if (Date.now() - (room.subsRefreshedAt || 0) < 10_000) return { error: 'rate' };
        room.subsRefreshedAt = Date.now();
        refreshSubtitles(room);
        return { msgs: [] };
      },
      // Host'un elle "Stremio'yu yeniden başlat" düğmesi.
      restartStremio: (room, uid) => {
        if (uid !== room.hostUserId) return { error: 'notHost' };
        stremioRestarter.restart('host').then((res) => {
          dispatch(room, [room.systemChat(res.ok ? 'Stremio yeniden başladı.' : 'Stremio yeniden başlatılamadı; elle kapatıp açmayı dene.')]);
        });
        return { msgs: [room.systemChat('Stremio yayın sunucusu yeniden başlatılıyor…')] };
      },
      requestRelay: (room, uid) => room.requestRelay(uid),
      releaseRelay: (room, uid) => room.releaseRelay(uid),
      // Host re-asks the configured addons for streams (one may have timed out
      // or been added after the room opened) and merges in anything new.
      refreshStreams: async (room, uid) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        if (Date.now() - (room.streamsRefreshedAt || 0) < 10_000) return { error: 'rate' };
        room.streamsRefreshedAt = Date.now();
        const { results, errors } = await addons.streams(config.get().addons, room.type, room.contentId);
        const res = room.addStreams(uid, normalizeStreams(results));
        if (res.error) return res;
        return { reply: { ok: true, added: res.added, errors: errors.map((e) => e.addonName) }, msgs: res.msgs };
      },
      // Host tests a torrent (peers/real download speed) before picking it for the
      // room — some show peers in the addon listing but never actually feed data.
      checkStream: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const stream = room.streams.find((s) => s.streamId === p?.streamId && s.kind === 'torrent');
        if (!stream) return { error: 'badStream' };
        activeChecks.set(stream.infoHash, (activeChecks.get(stream.infoHash) || 0) + 1);
        let result;
        try {
          result = await stremioLocal.checkTorrent(stream);
        } finally {
          const left = (activeChecks.get(stream.infoHash) || 1) - 1;
          if (left > 0) activeChecks.set(stream.infoHash, left);
          else activeChecks.delete(stream.infoHash);
          // The test opened this torrent in Stremio, which keeps downloading it forever.
          // Close it again unless someone in the room is actually watching it.
          const inUse = room.statsStreamIds().some(
            (id) => room.streams.find((s) => s.streamId === id)?.infoHash === stream.infoHash,
          );
          if (left === 0 && !inUse) await stremioLocal.removeTorrent(stream);
        }
        return { reply: { ok: true, ...result }, msgs: [] };
      },
      // Host pastes a magnet link: it becomes a stream of the current room and is picked for everyone.
      addMagnet: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const raw = parseMagnet(p?.magnet);
        if (!raw) return { error: 'badMagnet' };
        const [stream] = normalizeAddonStreams('Magnet', [raw]);
        if (!stream) return { error: 'badMagnet' };
        const added = room.addStreams(uid, [stream]);
        if (added.error) return added;
        const saved = room.streams.find(
          (s) => s.kind === 'torrent' && s.infoHash === stream.infoHash && s.fileIdx === stream.fileIdx,
        );
        const picked = room.setHostStream(uid, saved.streamId);
        if (picked.error) return picked;
        return {
          reply: { ok: true, streamId: saved.streamId },
          msgs: [...added.msgs, ...picked.msgs],
          after: () => refreshSubtitles(room),
        };
      },
      // Host searches Cinemeta's catalog for a different title to switch the room to.
      searchContent: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const q = String(p?.query || '').trim();
        if (q.length < 2) return { reply: { ok: true, results: [] }, msgs: [] };
        const [movies, series] = await Promise.all([addons.search('movie', q), addons.search('series', q)]);
        return { reply: { ok: true, results: [...movies, ...series].slice(0, 24) }, msgs: [] };
      },
      // Host picked a series in search: season/episode list for the picker.
      seriesEpisodes: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const id = String(p?.id || '');
        if (!isContentId(id)) return { error: 'badContent' };
        const episodes = await addons.seriesEpisodes(id).catch(() => []);
        if (!episodes.length) return { error: 'noEpisodes' };
        return { reply: { ok: true, episodes, watched: gecmis.izlenenler(id) }, msgs: [] };
      },
      // Host picks a search result: fetch its streams and switch the room to it.
      changeContent: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const { type, id } = p || {};
        if (!isContentType(type) || !isContentId(id)) return { error: 'badContent' };
        const [meta, { results }] = await Promise.all([
          addons.meta(type, id),
          addons.streams(config.get().addons, type, id),
        ]);
        const streams = normalizeStreams(results);
        if (!streams.length) return { error: 'noStreams' };
        const res = room.setContent(uid, { type, contentId: id, meta, streams, hostStreamId: streams[0].streamId });
        if (!res.error) {
          gecmis.ekle({ type, contentId: id, meta });
          res.after = () => refreshSubtitles(room);
        }
        return res;
      },
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

// Torrent peers/speed from the host's Stremio, pushed to rooms every 3 s.
let statsBusy = false;
const statsTimer = setInterval(async () => {
  if (statsBusy || !rooms.list().length) return;
  statsBusy = true;
  try {
    for (const room of rooms.list()) {
      const next = {};
      for (const id of room.statsStreamIds()) {
        const stream = room.streams.find((s) => s.streamId === id && s.kind === 'torrent');
        const stats = stream && (await stremioLocal.torrentStats(stream));
        if (stats) next[id] = stats;
      }
      dispatch(room, room.setTorrentStats(next));
      watchStall(room, next[room.hostStreamId]);
    }
  } finally {
    statsBusy = false;
  }
}, 3000);

// Stremio bazen takılıp hiçbir torrent için hız vermiyor; elle kapatıp açmak düzeltiyordu.
// Biri beklerken host'un torrent'i uzun süre hiç indirmiyorsa yayın sunucusunu kendimiz
// yeniden başlatıyoruz (seyrek: arada en az 5 dakika).
function watchStall(room, stats) {
  const waiting = room.connectedUsers().some((u) => ['loading', 'buffering'].includes(u.status?.state));
  const dead = !stats || (stats.downMbps < 0.05 && !(stats.progress >= 0.99));
  if (!waiting || !dead) {
    room.stallSince = null;
    return;
  }
  room.stallSince ||= Date.now();
  if (Date.now() - room.stallSince < STALL_MS) return;
  if (Date.now() - lastAutoRestart < AUTO_RESTART_COOLDOWN_MS) return;
  lastAutoRestart = Date.now();
  room.stallSince = null;
  dispatch(room, [room.systemChat('Stremio takıldı gibi görünüyor, yayın sunucusu yeniden başlatılıyor…')]);
  stremioRestarter.restart('takılma').then((res) => {
    dispatch(room, [room.systemChat(res.ok ? 'Stremio yeniden başladı.' : 'Stremio yeniden başlatılamadı; elle kapatıp açmayı dene.')]);
  });
}
statsTimer.unref();

// "Stop other downloads" room setting: while such a room has people in it, only the torrents
// being watched (in any room) or tested right now may stay open in the host's Stremio.
let cleanupBusy = false;
const cleanupTimer = setInterval(async () => {
  if (cleanupBusy) return;
  const all = rooms.list();
  if (!all.some((r) => r.settings.stopOtherDownloads && r.connectedUsers().length)) return;
  cleanupBusy = true;
  try {
    const keep = new Set(activeChecks.keys());
    for (const room of all) {
      for (const id of room.statsStreamIds()) {
        const hash = room.streams.find((s) => s.streamId === id)?.infoHash;
        if (hash) keep.add(hash);
      }
    }
    for (const infoHash of await stremioLocal.openTorrents()) {
      if (!keep.has(infoHash)) await stremioLocal.removeTorrent({ infoHash });
    }
  } finally {
    cleanupBusy = false;
  }
}, 5000);
cleanupTimer.unref();

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
    onRoomCreated: (room) => {
      gecmis.ekle({ type: room.type, contentId: room.contentId, meta: room.meta });
      refreshSubtitles(room);
    },
    gecmis,
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
  clearInterval(statsTimer);
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
if (!process.env.NO_TUNNEL) tunnel.start(); // NO_TUNNEL=1 for local test instances
