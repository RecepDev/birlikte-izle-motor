// Birlikte İzle: Stremio watch-party addon + room server + local control panel.
//   :7000  public  (addon, room pages, Socket.IO, relay)  <- cloudflared tunnel
//   :7001  panel   (GUI, room creation)                   <- 127.0.0.1 only

import { spawn } from 'node:child_process';
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
import { normalizeStreams, normalizeAddonStreams, bestStream } from './src/streams.js';
import { isit as isitStremio } from './src/stremio-isit.js';
import { parseMagnet } from './src/magnet.js';
import { createStremioLocal } from './src/stremio-local.js';
import { createStremioRestarter, stremioAcikDegilseAc } from './src/stremio-restart.js';
import { createIndirRouter } from './src/indir.js';
import { createGecmis } from './src/gecmis.js';
import { createKesif } from './src/kesif.js';
import { createGiris } from './src/giris.js';
import { createTercih } from './src/tercih.js';
import { createTorrentHiz } from './src/torrent-hiz.js';
import { setExtraSources } from './src/streams.js';
import { createRoomManager } from './src/rooms.js';
import { attachSocket } from './src/socket.js';
import { createTunnel, installCloudflared, readFixedTunnel } from './src/tunnel.js';
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
const kesif = createKesif({ file: path.join(DATA, 'kesif.json'), log });
const giris = createGiris({ file: path.join(DATA, 'giris.json'), log });
const tercih = createTercih({ file: path.join(DATA, 'tercih.json'), log });
const torrentHiz = createTorrentHiz({ file: path.join(DATA, 'trackerlar.json'), log });
// Ek tracker'lar yeni açılan torrent'lere ekleniyor; Stremio'nun peer arama sınırı yükseltiliyor.
setInterval(() => setExtraSources(torrentHiz.kaynaklar()), 60_000).unref();
setExtraSources(torrentHiz.kaynaklar());
setTimeout(() => torrentHiz.stremioAyarla(), 15_000).unref();
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
// Uygulamalar bu konu adını saklıyor; tünel adresi değişince yenisini ntfy.sh'den buluyorlar.
publicApp.get('/kesif.json', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.json({ konu: kesif.konu });
});
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
      // Sonraki bölümü önceden hazırla (host, bölümün son dakikalarında): stream listesi alınıp
      // en iyi kaynak seçiliyor ve torrent Stremio'da açılıp ilk parçası indiriliyor. Geçişte
      // bekleme olmuyor. Kapalı aralıkla okunuyor: Stremio tüm dosyayı arkadan indirmeye başlamasın.
      prefetchNext: async (room, uid) => {
        if (uid !== room.hostUserId || room.type !== 'series') return { reply: { ok: false }, msgs: [] };
        const [id, sezon, bolum] = String(room.contentId).split(':');
        const eps = (await addons.seriesEpisodes(id).catch(() => []))
          .filter((e) => e.season !== 0).sort((a, b) => a.season - b.season || a.episode - b.episode);
        const i = eps.findIndex((e) => e.season === Number(sezon) && e.episode === Number(bolum));
        const next = i >= 0 ? eps[i + 1] : null;
        if (!next) return { reply: { ok: false }, msgs: [] };
        const nextId = `${id}:${next.season}:${next.episode}`;
        if (room.prefetch?.contentId === nextId) return { reply: { ok: true }, msgs: [] };
        const [meta, { results }] = await Promise.all([addons.meta('series', nextId), addons.streams(config.get().addons, 'series', nextId)]);
        const streams = normalizeStreams(results);
        const onceki = room.streams.find((s) => s.streamId === room.hostStreamId);
        const pick = bestStream(streams, onceki?.quality);
        if (!pick) return { reply: { ok: false }, msgs: [] };
        room.prefetch = { contentId: nextId, meta, streams, pickId: pick.streamId, infoHash: pick.infoHash, at: Date.now() };
        if (pick.kind === 'torrent') isit(pick);
        log.info('Sonraki bölüm hazırlanıyor', { roomId: room.id, next: nextId });
        return { reply: { ok: true }, msgs: [] };
      },
      // İnternet penceresi: açık kalmış bir torrent'i kapat (host).
      closeTorrent: async (room, uid, p) => {
        if (uid !== room.hostUserId) return { error: 'notHost' };
        const infoHash = String(p?.infoHash || '').toLowerCase();
        if (!/^[0-9a-f]{40}$/.test(infoHash)) return { error: 'badStream' };
        await stremioLocal.removeTorrent({ infoHash });
        return { reply: { ok: true }, msgs: [] };
      },
      // Host'un kalite tercihi: "Oda aç" ekranı listeyi ve denetim sırasını buna göre yapıyor.
      setPreferredQuality: (room, uid, p) => {
        if (uid !== room.hostUserId) return { reply: { ok: false }, msgs: [] };
        return { reply: { ok: tercih.ayarla(p?.quality) }, msgs: [] };
      },
      // Tepki emojisi: herkese yayılır, videonun üstünde uçar.
      react: (room, uid, p) => {
        const emoji = String(p?.emoji || '');
        if (!['😂', '🔥', '❤️', '😮', '👏', '😢'].includes(emoji)) return { error: 'badInput' };
        const name = room.users.get(uid)?.name || '';
        return { msgs: [{ to: 'room', event: 'reaction', data: { emoji, name } }] };
      },
      // "İnternet" penceresi: bağlantı nerelere gidiyor. Host bilgisayarındaki Stremio'nun tüm
      // torrent'leri (indirme/yükleme) yalnızca host'a; relay kullanımı host'a hepsi, misafire kendisi.
      bandwidth: async (room, uid) => {
        const host = uid === room.hostUserId;
        let torrents = [];
        if (host) {
          const izlenen = new Map();
          for (const r of rooms.list()) {
            const s = r.streams.find((x) => x.streamId === r.hostStreamId);
            if (s?.infoHash) izlenen.set(s.infoHash, r.id === room.id ? 'bu oda' : 'başka oda');
          }
          try {
            const stats = await (await fetch('http://127.0.0.1:11470/stats.json', { signal: AbortSignal.timeout(4000) })).json();
            torrents = Object.values(stats || {}).map((t) => ({
              name: String(t.name || t.infoHash),
              infoHash: t.infoHash,
              downMbps: Math.round(((t.downloadSpeed || 0) * 8) / 1e5) / 10,
              upMbps: Math.round(((t.uploadSpeed || 0) * 8) / 1e5) / 10,
              peers: t.peers || 0,
              role: izlenen.get(t.infoHash) || (activeChecks.has(t.infoHash) ? 'hız denetimi'
                : rooms.list().some((r) => r.prefetch?.infoHash === t.infoHash) ? 'sonraki bölüm' : 'açık kalmış'),
            }));
          } catch { torrents = null; }
        }
        const rs = relay.stats(room.id);
        const relayUsers = host ? rs.users : rs.users.filter((u) => u.userId === uid);
        return { reply: { ok: true, host, torrents, relay: relayUsers, relayTotal: host ? rs.totalMbps : null }, msgs: [] };
      },
      // Host: "Daha çok kaynak bul" - Stremio'nun sınırlarını yükselt, Stremio'yu yeniden
      // başlat, torrent'i ek tracker'larla aç; izleyenler kaldıkları yerden devam eder.
      boostPeers: (room, uid) => {
        if (uid !== room.hostUserId) return { error: 'notHost' };
        setExtraSources(torrentHiz.kaynaklar());
        (async () => {
          await torrentHiz.stremioAyarla();
          const res = await stremioRestarter.restart('kaynak');
          if (res.ok) {
            const stream = room.streams.find((s) => s.streamId === room.hostStreamId);
            await torrentHiz.torrentAc(stream);
          }
          dispatch(room, [
            room.systemChat(res.ok ? 'Stremio daha çok kaynakla yeniden açıldı, video devam ediyor.' : 'Stremio yeniden başlatılamadı; elle kapatıp açmayı dene.'),
            ...(res.ok ? [{ to: 'room', event: 'stremioRestarted', data: {}, urgent: true }] : []),
          ]);
        })();
        return { msgs: [room.systemChat('Daha çok kaynak aranıyor: Stremio yeniden başlatılıyor…')] };
      },
      // Host'un elle "Stremio'yu yeniden başlat" düğmesi.
      restartStremio: (room, uid) => {
        if (uid !== room.hostUserId) return { error: 'notHost' };
        stremioRestarter.restart('host').then((res) => {
          // Açık video bağlantıları kopmuş durumda: host'un Stremio'sundan izleyenler (host ve
          // relay) videoyu kaldıkları yerden yeniden açsın; Stremio torrent'i de yeniden başlatır.
          dispatch(room, [
            room.systemChat(res.ok ? 'Stremio yeniden başladı, video yeniden açılıyor.' : 'Stremio yeniden başlatılamadı; elle kapatıp açmayı dene.'),
            ...(res.ok ? [{ to: 'room', event: 'stremioRestarted', data: {}, urgent: true }] : []),
          ]);
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
      // Misafirler de görebilir (oynatıcıdaki Bölümler kutusu); bölümü yine yalnızca host değiştirir.
      seriesEpisodes: async (room, uid, p) => {
        const id = String(p?.id || '');
        if (!isContentId(id)) return { error: 'badContent' };
        const episodes = await addons.seriesEpisodes(id).catch(() => []);
        if (!episodes.length) return { error: 'noEpisodes' };
        return { reply: { ok: true, episodes, watched: gecmis.izlenenler(id) }, msgs: [] };
      },
      // Girişi atla: dizinin girişinin bittiği saniye (host bir kez giriyor) ve sorulup sorulmadığı.
      introInfo: async (room) => ({
        reply: { ok: true, ...(room.type === 'series' ? giris.durum(room.contentId) : { intro: null, asked: true }) },
        msgs: [],
      }),
      // Host: { end } kaydet, { dismiss: true } bu dizi için sorma, { reset: true } sıfırla.
      introSet: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        if (room.type !== 'series') return { error: 'badContent' };
        if (p?.reset) giris.sifirla(room.contentId);
        else if (p?.dismiss) giris.sorma(room.contentId);
        else if (!giris.ayarla(room.contentId, p?.end)) return { error: 'badIntro' };
        return { reply: { ok: true, ...giris.durum(room.contentId) }, msgs: [] };
      },
      // Host picks a search result: fetch its streams and switch the room to it.
      changeContent: async (room, uid, p) => {
        const denied = room.requireHost(uid);
        if (denied) return denied;
        const { type, id } = p || {};
        if (!isContentType(type) || !isContentId(id)) return { error: 'badContent' };
        const onceki = room.streams.find((s) => s.streamId === room.hostStreamId);
        // Sonraki bölüm önceden hazırlandıysa (bkz. prefetchNext) onun listesi ve ısınmış torrent'i.
        const hazir = room.prefetch?.contentId === id && Date.now() - room.prefetch.at < 30 * 60_000 ? room.prefetch : null;
        let meta;
        let streams;
        if (hazir) ({ meta, streams } = hazir);
        else {
          let results;
          [meta, { results }] = await Promise.all([addons.meta(type, id), addons.streams(config.get().addons, type, id)]);
          streams = normalizeStreams(results);
        }
        if (!streams.length) return { error: 'noStreams' };
        // En iyi kaynak: önceki kaliteyle aynı, tek bölüm (paket değil), çok kaynaklı.
        const secilen = hazir ? streams.find((s) => s.streamId === hazir.pickId) : bestStream(streams, onceki?.quality);
        room.prefetch = null;
        const res = room.setContent(uid, { type, contentId: id, meta, streams, hostStreamId: (secilen || streams[0]).streamId });
        if (!res.error) {
          gecmis.ekle({ type, contentId: id, meta });
          res.msgs.push(...kaldigiYer(room));
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
  fixed: () => readFixedTunnel(path.join(DATA, 'tunel.json'), { log }),
  onChange: (s) => {
    if (s.state === 'up') {
      socketCtl.broadcastPublicUrl(s.url);
      kesif.adresDegisti(s.url);
    }
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
    dispatch(room, [
      room.systemChat(res.ok ? 'Stremio yeniden başladı, video yeniden açılıyor.' : 'Stremio yeniden başlatılamadı; elle kapatıp açmayı dene.'),
      ...(res.ok ? [{ to: 'room', event: 'stremioRestarted', data: {}, urgent: true }] : []),
    ]);
  });
}
statsTimer.unref();

// Stremio her video isteğinde dosyayı bir kez daha "seçiyor" ve bunları hiç bırakmıyor:
// uzun izlemede (sarmalar, önizlemeler, yeniden bağlanmalar) yüzlerce kopya birikiyor ve
// Stremio parça seçerken her birini tek tek dolaşıyor, indirme yavaşlıyor. Birikme çoksa,
// izlemeyi kesmemek için yalnızca video duraklatılmışken Stremio temiz açılıyor; oynatılınca
// kaldığı yerden devam ediyor (en fazla 20 dk'da bir).
const BIRIKME_SINIRI = 60;
const BIRIKME_ARALIK_MS = 20 * 60_000;
let sonBirikmeTemizligi = 0;
const birikmeTimer = setInterval(async () => {
  if (Date.now() - sonBirikmeTemizligi < BIRIKME_ARALIK_MS) return;
  const room = rooms.list().find((r) => r.users && [...r.users.values()].some((u) => u.connected));
  if (!room) return;
  const stream = room.streams.find((s) => s.streamId === room.hostStreamId);
  if (stream?.kind !== 'torrent' || !room.playback?.paused) return;
  let secim = 0;
  try {
    const stats = await (await fetch('http://127.0.0.1:11470/stats.json', { signal: AbortSignal.timeout(5000) })).json();
    secim = stats?.[stream.infoHash]?.selections?.length || 0;
  } catch { return; }
  if (secim < BIRIKME_SINIRI) return;
  sonBirikmeTemizligi = Date.now();
  log.warn("Stremio'da istek birikmesi, temizleniyor", { secim, infoHash: stream.infoHash });
  dispatch(room, [room.systemChat("Stremio'da biriken bağlantılar temizleniyor (birkaç saniye)…")]);
  const res = await stremioRestarter.restart('birikme');
  if (res.ok) await torrentHiz.torrentAc(stream);
  dispatch(room, [
    room.systemChat(res.ok ? 'Stremio temizlendi, video kaldığı yerden devam ediyor.' : 'Stremio yeniden başlatılamadı.'),
    ...(res.ok ? [{ to: 'room', event: 'stremioRestarted', data: {}, urgent: true }] : []),
  ]);
}, 60_000);
birikmeTimer.unref();

// Kaldığın yer: oynayan odaların konumu 15 sn'de bir geçmişe yazılıyor; aynı film/bölüm
// yeniden açılınca oradan başlıyor (başta ya da sonda değilse).
function kaldigiYer(room) {
  const k = gecmis.konumAl(room.type, room.contentId);
  if (!k || k.pos < 60 || (k.dur && k.pos > k.dur - 180)) return [];
  room.playback = { paused: true, position: k.pos, updatedAt: room.now() };
  const s = Math.round(k.pos);
  const saat = Math.floor(s / 3600);
  const dk = Math.floor((s % 3600) / 60);
  const zaman = `${saat ? `${saat}:${String(dk).padStart(2, '0')}` : dk}:${String(s % 60).padStart(2, '0')}`;
  return [room.playbackMsg(null), room.systemChat(`Kaldığın yerden devam: ${zaman} (baştan izlemek için çubuğu başa çek)`)];
}
const konumTimer = setInterval(() => {
  for (const room of rooms.list()) {
    if (!room.connectedUsers().length || room.playback.paused) continue;
    const host = room.users.get(room.hostUserId);
    const dur = Number(host?.status?.duration);
    const pos = room.currentPosition();
    if (pos > 30) gecmis.konumYaz(room.type, room.contentId, pos, Number.isFinite(dur) ? dur : null);
  }
}, 15_000);
konumTimer.unref();

// Sonraki bölümü ısıt: torrent Stremio'da açılıp ilk 8 MB okunuyor (kapalı aralık).
const isit = (stream) => isitStremio(stream, 8 * 1024 * 1024);

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
    for (const r of all) if (r.prefetch?.infoHash) keep.add(r.prefetch.infoHash);
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
      kaldigiYer(room);
      refreshSubtitles(room);
    },
    gecmis,
    tercih,
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
// Panel, baslat.vbs'nin açtığı ayrı profilli Edge uygulama penceresinde (data\edge-panel)
// çalışıyor. Sunucu "Kapat" ile kapanınca o pencere de kapansın. Yalnızca o profile ait
// Edge süreçlerine dokunuyoruz; kullanıcının kendi tarayıcısı etkilenmiyor.
function panelPenceresiniKapat() {
  if (process.platform !== 'win32') return;
  const betik = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | "
    + "Where-Object { $_.CommandLine -match 'edge-panel' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
  spawn('powershell', ['-NoProfile', '-Command', betik], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Sunucu kapatılıyor');
  panelPenceresiniKapat();
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
