// Local-only control panel (GUI) server. Never exposed through the tunnel.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { isContentId, isContentType } from './addon.js';
import { normalizeStreams, normalizeAddonStreams } from './streams.js';
import { masaustuAc } from './masaustu-baslat.js';

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
  gecmis = { liste: () => [], izlenenler: () => [] },
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
  app.get('/ara', page('ara.html'));

  // Stremio'dan gelen "masaüstünde aç" bağlantısı: uygulamayı burada başlatıyoruz,
  // tarayıcı sekmesi yalnızca sonucu gösteriyor.
  app.get('/ac', (req, res) => {
    const { type, id } = req.query;
    if (!isContentType(type) || !isContentId(String(id || ''))) return res.status(400).send('Geçersiz içerik');
    const hedef = `http://${req.headers.host}/new?${new URLSearchParams({ type, id })}`;
    const sonuc = masaustuAc(hedef);
    res.set('Cache-Control', 'no-store');
    res.type('html').send(sonuc.error
      ? `<!doctype html><meta charset="utf-8"><body style="background:#0e0f13;color:#e8e9ee;font:16px system-ui;padding:40px">
         <h2>Masaüstü uygulaması bulunamadı</h2>
         <p>Uygulamayı bir kez çalıştırman yeterli; sonra bu bağlantı doğrudan açar.</p>
         <p><a style="color:#9c86ff" href="${hedef}">Tarayıcıda devam et</a></p></body>`
      : `<!doctype html><meta charset="utf-8"><body style="background:#0e0f13;color:#e8e9ee;font:16px system-ui;padding:40px">
         <h2>Masaüstü uygulamasında açıldı</h2>
         <p>Bu sekme kendiliğinden kapanmazsa kapatabilirsin.</p>
         <p><a style="color:#9c86ff" href="${hedef}">Yine de tarayıcıda aç</a></p>
         <script>setTimeout(() => window.close(), 400);</script></body>`);
  });
  // Shared with the room page: which codecs this browser decodes.
  app.get('/js/codecs.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'codecs.js')));
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
    for (const e of errors) log.warn('Addon cevap vermedi', { addon: e.addonName, content: id, error: e.message });
    // Cached even with errors: room creation must use the exact list the host saw
    // (stream ids are positions). Reloading /new always refetches.
    streamCache.set(key, entry);
    return entry;
  }

  const validContent = (type, id) => isContentType(type) && typeof id === 'string' && isContentId(id);

  // NDJSON (one JSON object per line) instead of one big response: the host
  // sees each addon's streams the moment that addon replies, rather than
  // staring at "alınıyor…" until the slowest of them times out (up to ~20s).
  //
  // ?retry=Name1,Name2 re-asks only those addons (the ones that failed) and
  // keeps whatever already succeeded, instead of throwing away every addon's
  // results just because one of them didn't answer.
  // Panelden film/dizi arama: Stremio'ya hiç girmeden oda açabilmek için.
  app.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const [filmler, diziler] = await Promise.all([addons.search('movie', q), addons.search('series', q)]);
    res.json([...filmler.slice(0, 12), ...diziler.slice(0, 12)]);
  }));

  app.get('/api/series/:id/episodes', wrap(async (req, res) => {
    if (!isContentId(req.params.id)) return res.status(400).json({ error: 'Geçersiz id' });
    const izlenen = new Set(gecmis.izlenenler(req.params.id));
    try {
      const bolumler = await addons.seriesEpisodes(req.params.id);
      res.json(bolumler.map((b) => ({ ...b, watched: izlenen.has(`${b.season}:${b.episode}`) })));
    } catch {
      res.json([]);
    }
  }));

  // Daha önce oda açılan film ve diziler (en yenisi başta).
  app.get('/api/gecmis', (req, res) => res.json(gecmis.liste()));

  app.get('/api/streams', wrap(async (req, res) => {
    const { type, id, retry } = req.query;
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    const key = `${type}|${id}`;
    // retry=* : tüm addon'ları yeniden sor (sayfadaki "Addon'ları tekrar ara"), mevcut listeyi koruyarak.
    const retryAll = retry === '*';
    const retryNames = !retryAll && typeof retry === 'string' && retry ? retry.split(',').filter(Boolean) : null;
    // Tek önbellek kaydı, her addon cevabında yerinde güncelleniyor: ilk yükleme sürerken
    // yapılan tekrar arama da aynı listeye ekliyor, oda açılırken sayfadaki liste bulunuyor.
    let entry = retryAll || retryNames ? streamCache.get(key) : null;
    if (!entry) {
      entry = { at: Date.now(), meta: null, streams: [], errors: [], seq: 0 };
      streamCache.set(key, entry);
    }
    entry.seq ??= entry.streams.length;

    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    const write = (obj) => res.write(`${JSON.stringify(obj)}\n`);

    const allAddons = config.get().addons;
    const enabled = retryNames ? allAddons.filter((a) => retryNames.includes(a.name)) : allAddons;
    // Önbellekten gelse bile meta satırı yazılmalı: yoksa sayfa başlığı ham id olarak kalıyor.
    const metaPromise = (entry.meta ? Promise.resolve(entry.meta) : addons.meta(type, id)).then((meta) => {
      entry.meta = meta;
      write({ type: 'meta', meta });
      return meta;
    });
    const streamsPromise = addons.streams(enabled, type, id, (addonName, items, error) => {
      if (error) return write({ type: 'addon', addonName, streams: [], error });
      // Aynı addon tekrar cevap verdiyse eski sonuçlarının yerini alıyor (çift olmasın).
      // Kimlikler sayaçtan: silinenlerin numarası yeniden kullanılmıyor.
      const normalized = normalizeAddonStreams(addonName, items, entry.seq);
      entry.seq += normalized.length;
      entry.streams = [...entry.streams.filter((s) => s.addonName !== addonName), ...normalized];
      entry.errors = entry.errors.filter((e) => e.addonName !== addonName);
      write({ type: 'addon', addonName, streams: normalized, error: null });
    });
    const [, { errors }] = await Promise.all([metaPromise, streamsPromise]);
    for (const e of errors) log.warn('Addon cevap vermedi', { addon: e.addonName, content: id, error: e.message });
    // Bu istekte cevap vermeyenler hata listesine; başka addon'ların eski hataları aynen kalıyor.
    entry.errors = [...entry.errors.filter((e) => !errors.some((x) => x.addonName === e.addonName)), ...errors];
    entry.at = Date.now();
    write({ type: 'done', errors: entry.errors.map((e) => ({ addonName: e.addonName, message: e.message })) });
    res.end();
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

  // Odayı bu bilgisayardaki masaüstü uygulamasında aç. Host bağlantısı (#host=…) ile:
  // uygulama odaya host olarak giriyor.
  app.post('/api/masaustu-ac', (req, res) => res.json(masaustuAc(null)));

  app.post('/api/rooms/:id/masaustu', (req, res) => {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Oda yok' });
    const url = `${publicBase}/room/${room.id}#${new URLSearchParams({ host: room.creatorToken, name: config.get().nickname })}`;
    res.json(masaustuAc(url));
  });

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
