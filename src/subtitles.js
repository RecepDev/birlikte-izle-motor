// Room subtitle list: gathers subtitles from addons and the stream, serves
// them as WebVTT (decoded + converted on the server), accepts host uploads.

import express from 'express';
import { decodeSubtitle, toVtt, sortSubtitles, langLabel, normalizeLang } from '../public/js/shared/subtitle-text.js';
import { localTorrentUrl } from '../public/js/shared/stream-url.js';

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

export function guessLang(fileName) {
  const n = String(fileName).toLowerCase();
  if (/(^|[._\-\s])(tr|tur|turkish|türkçe|turkce)([._\-\s]|$)/.test(n)) return 'tur';
  if (/(^|[._\-\s])(en|eng|english)([._\-\s]|$)/.test(n)) return 'eng';
  return 'und';
}

export function createSubtitleService({ addons, getAddons, stremioLocal, log, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const perRoom = new WeakMap(); // room -> { byUrl: Map, uploads: [], seq, uploadSeq }

  function stateOf(room) {
    let s = perRoom.get(room);
    if (!s) {
      s = { byUrl: new Map(), uploads: [], seq: 0, uploadSeq: 0 };
      perRoom.set(room, s);
    }
    return s;
  }

  function upsert(room, sub, { source, addonName, matched = false, order }) {
    const s = stateOf(room);
    let e = s.byUrl.get(sub.url);
    if (!e) {
      const lang = normalizeLang(sub.lang);
      e = { subId: `a${++s.seq}`, url: sub.url, lang, source, matched: false, vtt: null, order };
      e.label = `${langLabel(lang)}${addonName ? ` · ${addonName}` : ''}`;
      s.byUrl.set(sub.url, e);
    }
    if (matched) e.matched = true;
    if (order < e.order) e.order = order;
    return e;
  }

  function publish(room) {
    const s = stateOf(room);
    const ordered = [...s.byUrl.values()].sort((a, b) => a.order - b.order);
    return room.setSubtitles(sortSubtitles([...ordered, ...s.uploads]));
  }

  function find(room, subId) {
    return room.subtitles.find((x) => x.subId === subId) || null;
  }

  return {
    // Publishes the plain list first, then re-ranks with the host video's hash.
    async refresh(room, dispatch) {
      const stream = room.streams.find((x) => x.streamId === room.hostStreamId);
      (stream?.subtitles || []).forEach((sub, i) =>
        upsert(room, sub, { source: 'stream', addonName: stream.addonName, matched: true, order: -1000 + i }),
      );
      const list = getAddons();
      const plain = await addons.subtitles(list, room.type, room.contentId);
      const plainUrls = new Set(plain.subtitles.map((x) => x.url));
      plain.subtitles.forEach((sub, i) => upsert(room, sub, { source: 'addon', addonName: sub.addonName, order: 1000 + i }));
      dispatch(publish(room));

      if (!stream) return;
      const videoUrl = stream.kind === 'torrent' ? localTorrentUrl(stream) : stream.url;
      const video = await stremioLocal.opensubHash(videoUrl);
      if (!video) return;
      const hashed = await addons.subtitles(list, room.type, room.contentId, video);
      hashed.subtitles.forEach((sub, i) =>
        upsert(room, sub, { source: 'addon', addonName: sub.addonName, matched: !plainUrls.has(sub.url), order: i }),
      );
      dispatch(publish(room));
      log.info('Altyazılar video hash ile güncellendi', { roomId: room.id, count: hashed.subtitles.length });
    },

    async getVtt(room, subId) {
      const e = find(room, subId);
      if (!e) return null;
      if (e.vtt) return e.vtt;
      const res = await fetchImpl(e.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > MAX_SUBTITLE_BYTES) throw new Error('Altyazı dosyası çok büyük');
      e.vtt = toVtt(decodeSubtitle(buf, e.lang));
      return e.vtt;
    },

    addUpload(room, { name, bytes }) {
      const s = stateOf(room);
      const lang = guessLang(name);
      const entry = {
        subId: `u${++s.uploadSeq}`,
        lang,
        label: `📄 ${String(name).slice(0, 60)}`,
        source: 'upload',
        matched: false,
        vtt: toVtt(decodeSubtitle(bytes, lang)),
      };
      s.uploads.push(entry);
      return { entry, msgs: publish(room) };
    },
  };
}

export function createSubtitleRouter({ rooms, service, dispatch, log }) {
  const router = express.Router();

  router.get('/sub/:roomId/:subId.vtt', async (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return res.status(404).end();
    try {
      const vtt = await service.getVtt(room, req.params.subId);
      if (!vtt) return res.status(404).end();
      res.set('Cache-Control', 'private, max-age=3600');
      res.type('text/vtt; charset=utf-8').send(vtt);
    } catch (err) {
      log.warn('Altyazı indirilemedi', { roomId: room.id, subId: req.params.subId, error: err.message });
      res.status(502).end();
    }
  });

  router.post(
    '/room/:roomId/subtitles',
    express.raw({ type: () => true, limit: MAX_SUBTITLE_BYTES }),
    (req, res) => {
      const room = rooms.get(req.params.roomId);
      if (!room) return res.status(404).json({ error: 'Oda yok' });
      const user = room.findByToken(String(req.headers['x-user-token'] || ''));
      if (!user || user.id !== room.hostUserId) return res.status(403).json({ error: 'Sadece host yükleyebilir' });
      if (!req.body?.length) return res.status(400).json({ error: 'Dosya boş' });
      let name = 'altyazi.srt';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] || name));
      } catch { /* keep default */ }
      const { entry, msgs } = service.addUpload(room, { name, bytes: new Uint8Array(req.body) });
      dispatch(room, msgs);
      res.json({ subId: entry.subId });
    },
  );

  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dosya 2 MB sınırını aşıyor' });
    next(err);
  });

  return router;
}
