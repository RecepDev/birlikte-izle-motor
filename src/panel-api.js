// Local-only control panel (GUI) server. Never exposed through the tunnel.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { isContentId, isContentType } from './addon.js';
import { normalizeStreams, normalizeAddonStreams } from './streams.js';
import { isit, OLCUM_BAYT_TS, DOGRULAMA_BAYT, olcumleriDurdur } from './stremio-isit.js';
import { STREMIO_BASE } from '../public/js/shared/stream-url.js';
import { kaydet as torrentKaydet, dokun as torrentDokun } from './bizim-torrentler.js';
import { masaustuAc } from './masaustu-baslat.js';
import { createOtomatikIndirme } from './indirme-otomatik.js';
import { magnetCoz, baslikTahmin, videoMu } from './magnet-coz.js';
import { seceneklerDogrula } from './indirme-secenek.js';

const STREAM_CACHE_MS = 10 * 60 * 1000;

// Express 4 does not catch rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createPanelApp({
  kaynakHafiza = null,
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
  kutuphane = { liste: () => [], ekle: () => false, cikar: () => false },
  indirmeSecenek = { oku: () => ({}), yaz: () => ({}) },
  izlendi = { tumu: () => ({}), filmIzlendiMi: () => false, bolumIzlendiMi: () => false, butunAyarla() {}, bolumlerAyarla() {} },
  tercih = { kalite: () => null },
  motorBilgisi = null,
  motorPanel = null,
  indirme = null,
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
    res.set('Content-Security-Policy', "default-src 'self'; img-src * data:; frame-ancestors 'self'");
    res.type('html').send(html);
  };
  // Eski sunucu paneli adresi: artık uygulama kabuğundaki Sunucu görünümü (kısayollar ve kabuk '/' açar).
  app.get('/', (req, res) => res.redirect('/sunucu'));
  app.get('/new', page('new.html'));
  app.get('/ara', (req, res) => res.redirect('/ana')); // eski "Film ara" sayfası kaldırıldı
  // Ana sayfa / Keşfet / İndirilenler / Ayarlar tek uygulama sayfasında (panel/js/uygulama.js).
  for (const yol of ['/ana', '/kesfet', '/kutuphane', '/indirilenler', '/ayarlar', '/sunucu', '/eklentiler']) app.get(yol, page('uygulama.html'));
  app.get('/detay', page('detay.html'));

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
  app.get('/js/diyalog.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'diyalog.js')));
  app.get('/js/kisayollar.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'kisayollar.js')));
  app.get('/css/diyalog.css', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'css', 'diyalog.css')));
  app.get('/js/codecs.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'codecs.js')));
  app.get('/js/kaynak-sec.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'shared', 'kaynak-sec.js')));
  app.get('/js/diller.js', (req, res) => res.sendFile(path.join(panelDir, '..', 'public', 'js', 'shared', 'diller.js')));
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
      // Motor: "torrserver" ya da "stremio"; istenen torrserver olup Stremio'ya düşüldüyse panel uyarıyor.
      motor: motorBilgisi?.() ?? null,
      addonUrl: `${publicBase}/manifest.json`,
    });
  }));

  // Motor kartı: motor durumu, önbellek, açık torrent'ler (hız, peer, odada izleniyor mu).
  const izlenenler = () => new Set(rooms.list().flatMap((r) => r.streams
    .filter((s) => s.streamId === r.hostStreamId && s.infoHash).map((s) => s.infoHash.toLowerCase())));
  app.get('/api/motor', wrap(async (req, res) => {
    if (!motorPanel) return res.status(404).json({ error: 'yok' });
    let stats = {};
    try {
      stats = await (await fetch(`${STREMIO_BASE}/stats.json`, { signal: AbortSignal.timeout(4000) })).json();
    } catch { /* motor kapalı */ }
    const izlenen = izlenenler();
    const mbps = (bps) => Math.round(((Number(bps) || 0) * 8) / 1e5) / 10;
    const torrentler = Object.values(stats || {}).filter((t) => t?.infoHash).map((t) => ({
      infoHash: t.infoHash,
      ad: t.name || null,
      peers: t.peers || 0,
      bulunan: t.swarmSize || 0,
      indirmeMbps: mbps(t.downloadSpeed),
      yuklemeMbps: mbps(t.uploadSpeed),
      izleniyor: izlenen.has(String(t.infoHash).toLowerCase()),
    }));
    res.json({ ...(await motorPanel.durum()), torrentler });
  }));
  app.post('/api/motor/yeniden-baslat', wrap(async (req, res) => res.json(await motorPanel.yenidenBaslat())));
  app.post('/api/motor/onbellek-bosalt', wrap(async (req, res) => res.json(await motorPanel.onbellekBosalt())));
  app.post('/api/motor/onbellek', wrap(async (req, res) => {
    if (!motorPanel) return res.status(404).json({ error: 'yok' });
    const { gb, klasor } = req.body || {};
    const r = await motorPanel.onbellekAyarla({ gb, klasor });
    res.status(r.error ? 400 : 200).json(r);
  }));
  app.put('/api/motor/ayar', (req, res) => {
    const yeni = {};
    if (req.body?.motor !== undefined) yeni.motor = req.body.motor;
    if (req.body?.bekci !== undefined) yeni.bekci = req.body.bekci;
    if (req.body?.siteden !== undefined) yeni.siteden = req.body.siteden;
    const r = motorPanel.ayarla(yeni);
    res.status(r.error ? 400 : 200).json(r);
  });

  // ---- önden indirme (çevrimdışı izleme) ----------------------------------------------
  // Kişi bir kaynağı diske indirtiyor; sonra o bölüm torrent'e hiç gidilmeden
  // oynatılıyor (motor taklidi dosyayı diskten servis ediyor).
  // Şu an inen dosyanın torrent'i: oda aç ekranı/sayfa kapanışı kapatmasın (indirme kopardı: "aborted").
  const indiriliyor = (h) => Boolean(indirme?.inenHashler().includes(h));
  const otomatikIndirme = indirme
    ? createOtomatikIndirme({ addons, config, tercih, kaynakHafiza, secenek: indirmeSecenek, indirme, log })
    : null;

  app.get('/api/indirme', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    res.json({ ...indirme.ayar(), kayitlar: indirme.liste(), arama: otomatikIndirme.liste() });
  });

  // Arka planda indir: kaynağı otomatik mod seçer (tercih edilen kalite, seed, kaynak hafızası).
  // Gövde: { items: [{ type, id }] } — film, bölüm ya da bir sezonun bütün bölümleri.
  app.post('/api/indirme/otomatik', wrap(async (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .filter((x) => x && validContent(x.type, x.id)).slice(0, 80)
      .map((x) => ({ type: x.type, id: x.id }));
    if (!items.length) return res.status(400).json({ error: 'Geçersiz içerik' });
    // Gövdede `secenek` varsa (soru penceresinden) yalnız bu indirmeler için o uygulanır; yoksa kayıtlı seçenekler.
    const istenen = req.body?.secenek && typeof req.body.secenek === 'object' ? seceneklerDogrula(req.body.secenek) : null;
    const toplu = req.body?.toplu === 'sezon' || req.body?.toplu === 'dizi' ? req.body.toplu : null;
    res.json(await otomatikIndirme.ekle(items, istenen, toplu));
  }));
  // İndirme seçenekleri (kalite, boyut, HDR, dil, Türkçe altyazı, Blu-ray) ve "indirirken sor" anahtarı.
  app.get('/api/indirme/secenek', (req, res) => res.json(indirmeSecenek.oku()));
  app.post('/api/indirme/secenek', (req, res) => res.json(indirmeSecenek.yaz(req.body)));

  app.post('/api/indirme/otomatik/iptal', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const r = otomatikIndirme.iptal(String(req.body?.anahtar || ''));
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/indirme', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const { infoHash, fileIdx, filename, ad, type, contentId, kalite, boyut, sources, poster } = req.body || {};
    const r = indirme.ekle({
      infoHash,
      fileIdx: Number.isInteger(fileIdx) ? fileIdx : null,
      filename: typeof filename === 'string' ? filename : null,
      ad: typeof ad === 'string' ? ad : '',
      type: typeof type === 'string' ? type : null,
      contentId: typeof contentId === 'string' ? contentId : null,
      poster: typeof poster === 'string' ? poster : null,
      kalite: typeof kalite === 'string' ? kalite : null,
      boyut: Number(boyut) || null,
      sources: Array.isArray(sources) ? sources.filter((x) => typeof x === 'string').slice(0, 40) : [],
    });
    res.status(r.error ? 400 : 200).json(r);
  });

  for (const [yol, islem] of [['duraklat', 'duraklat'], ['surdur', 'surdur'], ['sil', 'sil']]) {
    app.post(`/api/indirme/${yol}`, (req, res) => {
      if (!indirme) return res.status(404).json({ error: 'yok' });
      const r = indirme[islem](String(req.body?.id || ''));
      res.status(r.error ? 400 : 200).json(r);
    });
  }

  app.post('/api/indirme/izlerken-duraklat', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    res.json(indirme.izlerkenDuraklatAyarla(req.body?.acik === true));
  });

  app.post('/api/indirme/hiz-limiti', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const r = indirme.hizLimitiAyarla(req.body?.mbps);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/indirme/eszamanli', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const r = indirme.esZamanliAyarla(req.body?.sayi);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post('/api/indirme/klasor', (req, res) => {
    if (!indirme) return res.status(404).json({ error: 'yok' });
    const r = indirme.klasorAyarla(req.body?.klasor);
    res.status(r.error ? 400 : 200).json(r);
  });

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

  // Ana sayfa / Keşfet: Cinemeta katalogları. Kısa süre önbellekte (her açılışta Cinemeta'ya gidilmesin).
  const katalogOnbellek = new Map(); // anahtar -> { at, v }
  const onbellekli = async (anahtar, ms, getir) => {
    const e = katalogOnbellek.get(anahtar);
    if (e && Date.now() - e.at < ms) return e.v;
    const v = await getir();
    katalogOnbellek.set(anahtar, { at: Date.now(), v });
    return v;
  };
  app.get('/api/katalog-secenekleri', wrap(async (req, res) => {
    try {
      res.json(await onbellekli('secenekler', 60 * 60_000, () => addons.katalogSecenekleri()));
    } catch {
      res.json([]);
    }
  }));
  app.get('/api/katalog', wrap(async (req, res) => {
    const { type, id } = req.query;
    const genre = String(req.query.genre || '').slice(0, 40);
    const skip = Math.max(0, Math.min(5000, Math.floor(Number(req.query.skip) || 0)));
    if (!isContentType(type) || !/^[A-Za-z0-9_-]{1,30}$/.test(String(id || ''))) return res.status(400).json({ error: 'Geçersiz katalog' });
    try {
      res.json(await onbellekli(`k|${type}|${id}|${genre}|${skip}`, 10 * 60_000, () => addons.katalog(type, id, { genre, skip })));
    } catch {
      res.json([]);
    }
  }));

  app.get('/api/detay', wrap(async (req, res) => {
    const { type, id } = req.query;
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    try {
      const d = await onbellekli(`d|${type}|${String(id).split(':')[0]}`, 30 * 60_000, () => addons.metaDetay(type, id));
      res.json(d || { error: 'yok' });
    } catch {
      res.status(502).json({ error: 'Cinemeta cevap vermedi' });
    }
  }));

  // ---- magnet: arama kutusuna yapıştırılan magnet'le oda/indirme --------------------------------
  // 1) coz: magnet'ten kimlik/ad/tracker + ada göre film/dizi tahmini.
  // 2) dosyalar: torrent motorda açılır, metadata gelince dosya listesi döner (kişi dosya seçer).
  // 3) kaynak: seçilen dosya, eşleşen IMDb içeriğinin kaynak listesine "Magnet" kaynağı olarak eklenir
  //    (oda, altyazı, geçmiş hep IMDb kimliğine bağlı); sonra normal POST /api/rooms ile oda açılır.
  const sureAsimi = (ms) => new Promise((r) => setTimeout(r, ms));
  app.post('/api/magnet/coz', (req, res) => {
    const m = magnetCoz(req.body?.magnet);
    if (!m) return res.status(400).json({ error: 'Geçerli bir magnet bağlantısı değil' });
    res.json({ ...m, tahmin: baslikTahmin(m.ad) });
  });

  app.post('/api/magnet/dosyalar', wrap(async (req, res) => {
    const ih = String(req.body?.infoHash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(ih)) return res.status(400).json({ error: 'Geçersiz kimlik' });
    const trackerlar = (Array.isArray(req.body?.trackerlar) ? req.body.trackerlar : []).filter((t) => typeof t === 'string').slice(0, 40);
    torrentKaydet([{ kind: 'torrent', infoHash: ih }]);
    torrentDokun(ih);
    const govde = JSON.stringify({ peerSearch: { sources: [`dht:${ih}`, ...trackerlar.map((t) => `tracker:${t}`)], min: 40, max: 200 } });
    await fetch(`${STREMIO_BASE}/${ih}/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: govde, signal: AbortSignal.timeout(8000) })
      .catch(() => null);
    const son = Date.now() + 45_000;
    while (Date.now() < son) {
      torrentDokun(ih);
      const s = await fetch(`${STREMIO_BASE}/${ih}/stats.json`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (s?.files?.length) {
        const dosyalar = s.files.map((f) => ({ ad: String(f.name || f.path || '').split('/').pop(), yol: String(f.path || f.name || ''), boyut: Number(f.length) || 0 }))
          .map((f) => ({ ...f, video: videoMu(f.ad) }))
          .sort((a, b) => Number(b.video) - Number(a.video) || b.boyut - a.boyut);
        return res.json({ ad: s.name || null, dosyalar });
      }
      await sureAsimi(500);
    }
    res.status(504).json({ error: 'Torrent bilgisi 45 sn içinde gelmedi (kaynak/peer bulunamadı). Tracker içermeyen magnet yavaş olabilir, tekrar dene.' });
  }));

  app.post('/api/magnet/kaynak', wrap(async (req, res) => {
    const { type, id, filename, ad } = req.body || {};
    const ih = String(req.body?.infoHash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(ih) || !validContent(type, id)) return res.status(400).json({ error: 'Geçersiz istek' });
    const trackerlar = (Array.isArray(req.body?.trackerlar) ? req.body.trackerlar : []).filter((t) => typeof t === 'string').slice(0, 40);
    const dosya = typeof filename === 'string' ? filename.slice(0, 300) : null;
    const boyut = Number(req.body?.boyut) || null;
    const ham = {
      name: 'Magnet',
      title: `${dosya || ad || ih}${boyut ? `
💾 ${(boyut / 1e9).toFixed(2)} GB` : ''}`,
      infoHash: ih,
      behaviorHints: { filename: dosya, ...(boyut ? { videoSize: boyut } : {}) },
      sources: [`dht:${ih}`, ...trackerlar.map((t) => `tracker:${t}`)],
    };
    const key = `${type}|${id}`;
    let entry = streamCache.get(key);
    if (!entry) {
      entry = { at: Date.now(), meta: null, streams: [], errors: [], seq: 0 };
      streamCache.set(key, entry);
    }
    entry.meta ||= await addons.meta(type, id);
    entry.seq ??= entry.streams.length;
    const [akis] = normalizeAddonStreams('Magnet', [ham], entry.seq);
    if (!akis) return res.status(400).json({ error: 'Kaynak oluşturulamadı' });
    entry.seq += 1;
    entry.streams = [...entry.streams.filter((x) => !(x.addonName === 'Magnet' && x.infoHash === ih && x.filename === dosya)), akis];
    entry.at = Date.now(); // loadStreams bu listeyi kullansın (önbellek süresi dolmasın)
    torrentKaydet([akis]);
    res.json({ streamId: akis.streamId, meta: { name: entry.meta?.name || id, poster: entry.meta?.poster || null } });
  }));

  app.get('/api/series/:id/episodes', wrap(async (req, res) => {
    if (!isContentId(req.params.id)) return res.status(400).json({ error: 'Geçersiz id' });
    const gecmisBolumleri = gecmis.izlenenler(req.params.id);
    try {
      const bolumler = await addons.seriesEpisodes(req.params.id);
      res.json(bolumler.map((b) => ({ ...b, watched: izlendi.bolumIzlendiMi(req.params.id, `${b.season}:${b.episode}`, gecmisBolumleri) })));
    } catch {
      res.json([]);
    }
  }));

  // Daha önce oda açılan film ve diziler (en yenisi başta).
  app.get('/api/gecmis', (req, res) => res.json(gecmis.liste()));
  // Kütüphane: kişinin kendi eklediği film/diziler.
  // Her kayıtta `bitti`: film elle izlendi işaretliyse; dizide yayımlanmış (özel bölümler hariç) bütün bölümler izlenmişse.
  app.get('/api/kutuphane', wrap(async (req, res) => {
    const sonuc = await Promise.all(kutuphane.liste().map(async (k) => {
      if (k.type === 'movie') return { ...k, bitti: izlendi.filmIzlendiMi(k.id) };
      try {
        const gb = gecmis.izlenenler(k.id);
        const bolumler = (await onbellekli(`bol|${k.id}`, 30 * 60_000, () => addons.seriesEpisodes(k.id)))
          .filter((b) => b.season > 0 && (!b.released || Date.parse(b.released) <= Date.now()));
        const izlenen = bolumler.filter((b) => izlendi.bolumIzlendiMi(k.id, `${b.season}:${b.episode}`, gb)).length;
        return { ...k, bitti: bolumler.length > 0 && izlenen === bolumler.length, izlenen, toplam: bolumler.length };
      } catch {
        return { ...k, bitti: false };
      }
    }));
    res.json(sonuc);
  }));
  // Elle izledim işaretleri. Gövde: { type, id, deger: true|false, bolumler?: ["s:e", ...] } (bolumler yoksa bütün film/dizi).
  app.get('/api/izlendi', (req, res) => res.json(izlendi.tumu()));
  app.post('/api/izlendi', (req, res) => {
    const { type, id, deger, bolumler } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    const temel = String(id).split(':')[0];
    if (Array.isArray(bolumler) && type === 'series') {
      const liste = bolumler.filter((x) => /^\d+:\d+$/.test(String(x))).slice(0, 2000).map(String);
      izlendi.bolumlerAyarla(temel, liste, deger === true);
    } else {
      izlendi.butunAyarla(type, temel, deger === true, gecmis.izlenenler(temel));
    }
    res.json({ ok: true });
  });
  app.post('/api/kutuphane/ekle', (req, res) => {
    const { type, id, name, poster, year } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    res.json({ ok: kutuphane.ekle({ type, id: String(id).split(':')[0], name, poster, year }) });
  });
  app.post('/api/kutuphane/cikar', (req, res) => {
    const { type, id } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    res.json({ ok: kutuphane.cikar(type, String(id).split(':')[0]) });
  });
  app.get('/api/tercih', (req, res) => res.json({ kalite: tercih.kalite(), internetMbps: tercih.internetMbps?.() ?? null }));
  // Gövdede hangisi varsa o yazılıyor: { kalite } ve/ya { internetMbps } (null = sil).
  app.post('/api/tercih', (req, res) => {
    const b = req.body || {};
    let ok = true;
    if ('kalite' in b) ok = (tercih.ayarla?.(b.kalite) ?? false) && ok;
    if ('internetMbps' in b) ok = (tercih.internetAyarla?.(b.internetMbps) ?? false) && ok;
    res.json({ ok });
  });

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
      torrentKaydet(normalized);
      entry.errors = entry.errors.filter((e) => e.addonName !== addonName);
      write({ type: 'addon', addonName, streams: normalized, error: null });
      // İçerik seçilir seçilmez en umut verici torrent'ler Stremio'da açılıp kaynak aramaya
      // başlıyor: hangisi seçilirse seçilsin oda açılınca beklemeden oynasın. En iyi aday +
      // en çok kaynaklı 3 tek bölüm; seçilmeyenleri oda açılınca temizlik kapatıyor.
      entry.isitildi ||= new Set();
      // Eldeki listenin ilk 3'ü: önce tercih edilen kalite (yoksa 4K) içinden en çok kaynaklılar, yetmezse
      // diğerleri. Sonra gelen addon daha iyisini getirirse o da açılıyor (toplam en fazla 5). Eskiden 6/10:
      // aynı anda çok torrent bağlanmayı yavaşlatıyor (ölçüm 2026-10-07: tek tek açılan torrent'te film
      // bilgisi medyan 1.6 sn, 8'i birden açılınca 10 sn ve 8'in 2'si 20 sn'de gelmedi).
      const hedef = tercih.kalite() || '2160p';
      const k4 = (s) => (s.quality === hedef ? 1 : 0);
      const adaylar = entry.streams.filter((s) => s.kind === 'torrent')
        .sort((a, b) => k4(b) - k4(a) || (Number(b.seeders) || 0) - (Number(a.seeders) || 0)).slice(0, 3);
      for (const s of adaylar) {
        if (s?.kind !== 'torrent' || entry.isitildi.has(s.infoHash) || entry.isitildi.size >= 5) continue;
        entry.isitildi.add(s.infoHash);
        isit(s);
      }
    });
    const [, { errors }] = await Promise.all([metaPromise, streamsPromise]);
    for (const e of errors) log.warn('Addon cevap vermedi', { addon: e.addonName, content: id, error: e.message });
    // Bu istekte cevap vermeyenler hata listesine; başka addon'ların eski hataları aynen kalıyor.
    entry.errors = [...entry.errors.filter((e) => !errors.some((x) => x.addonName === e.addonName)), ...errors];
    entry.at = Date.now();
    write({ type: 'done', errors: entry.errors.map((e) => ({ addonName: e.addonName, message: e.message })) });
    res.end();
  }));

  // Oda aç ekranı açık ve görünürken 8 sn'de bir: o içeriğin torrent'leri açık kalabilir.
  // Sayfa kapanınca/arka plana geçince hemen kapatılıyor (görünmeyen torrent arkada indirmesin).
  const icerikHashleri = (body) => {
    const entry = streamCache.get(`${body?.type}|${body?.id}`);
    return (entry?.streams || []).filter((s) => s.kind === 'torrent' && s.infoHash).map((s) => s.infoHash);
  };
  app.post('/api/bakiyor', wrap(async (req, res) => {
    for (const h of icerikHashleri(req.body)) torrentDokun(h);
    res.json({ ok: true });
  }));
  app.post('/api/sayfa-kapandi', wrap(async (req, res) => {
    const acik = new Set(await stremioLocal.openTorrents().catch(() => []));
    const odada = new Set(rooms.list().flatMap((r) => r.streams.map((s) => s.infoHash)));
    for (const h of icerikHashleri(req.body)) {
      if (acik.has(h) && !odada.has(h) && !indiriliyor(h)) stremioLocal.removeTorrent({ infoHash: h }).catch(() => {});
    }
    res.json({ ok: true });
  }));

  // Otomatik seçim: dizide daha önce iyi indiren kaynağın grubu (bkz. kaynak-hafiza.js).
  app.get('/api/kaynak-hafiza', (req, res) => res.json(kaynakHafiza?.oku(String(req.query.id || '')) || null));
  // Bütün içerikler: yayın gruplarının iyi/kötü sayıları ve bırakılan (kötü) torrent'ler.
  app.get('/api/kaynak-gruplari', (req, res) => res.json(kaynakHafiza?.ozet?.() || { gruplar: {}, kotu: [] }));

  // Oda aç ekranı: Stremio'da açık (denetlenen) torrent'lerin canlı durumu: bağlı kişi, hız.
  app.get('/api/torrent-durum', wrap(async (req, res) => {
    try {
      const stats = await (await fetch(`${STREMIO_BASE}/stats.json`, { signal: AbortSignal.timeout(4000) })).json();
      const out = {};
      for (const t of Object.values(stats || {})) {
        out[t.infoHash] = { peers: t.peers || 0, downMbps: Math.round(((t.downloadSpeed || 0) * 8) / 1e5) / 10, found: t.swarmSize || 0 };
      }
      res.json(out);
    } catch {
      res.json({});
    }
  }));

  // Oda aç ekranı: denetimi biten torrent'i Stremio'da kapat (seçilmeyenler hız yemesin).
  app.post('/api/torrent-kapat', wrap(async (req, res) => {
    const infoHash = String(req.body?.infoHash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(infoHash)) return res.status(400).json({ error: 'Geçersiz' });
    // Bir odada izleniyorsa dokunma.
    const izleniyor = rooms.list().some((r) => r.streams.some((s) => s.streamId === r.hostStreamId && s.infoHash === infoHash));
    if (!izleniyor && !indiriliyor(infoHash)) await stremioLocal.removeTorrent({ infoHash }).catch(() => {});
    res.json({ ok: true });
  }));

  // Oda aç ekranı: seçilen torrent'leri denetle (Stremio'da açıp kaynak aramaya başlat).
  app.post('/api/torrent-denetle', wrap(async (req, res) => {
    const { type, id, streamIds } = req.body || {};
    // bas: okumanın başladığı bayt (doğrulamadan sonra devam eden adaylar okunmuş kısmı yeniden okumasın).
    const bas = Math.max(0, Math.floor(Number(req.body?.bas) || 0));
    if (!validContent(type, id) || !Array.isArray(streamIds)) return res.status(400).json({ error: 'Geçersiz' });
    const entry = streamCache.get(`${type}|${id}`);
    if (!entry) return res.status(404).json({ error: 'Liste yok' });
    // Ölçüm için okunan miktar: Stremio açtığı torrent'i kendiliğinden indirmeye devam ediyor, 1 MB
    // yetiyor. TorrServer okuyan kalmayınca duruyor: hız ancak okurken ölçülüyor, keşifte 16 MB okunuyor
    // (2026-10-07: 1 MB'ta bütün adaylar ~0 Mbps görünüyordu, seçim rastgeleydi). Asıl hız, umut veren
    // aday tek başına doğrulanırken ölçülüyor (/api/torrent-dogrula). Okunan kısım disk önbelleğine de
    // yazılıyor: seçilen kaynakta boşa gitmiyor.
    const bayt = motorBilgisi?.()?.kullanilan === 'torrserver' ? OLCUM_BAYT_TS : 1024 * 1024;
    let n = 0;
    for (const sid of streamIds.slice(0, 12)) {
      const s = entry.streams.find((x) => x.streamId === sid);
      if (s?.kind === 'torrent') {
        isit(s, bayt, { bas });
        n += 1;
      }
    }
    res.json({ ok: true, n });
  }));

  // Oda aç otomatik seçimi: yeni keşif grubu başlarken süren ölçüm okumaları durur (hat yeni gruba kalsın).
  app.post('/api/torrent-olcum-durdur', (req, res) => {
    olcumleriDurdur();
    res.json({ ok: true });
  });

  // Oda aç otomatik seçimi: umut veren adayı tek başına ölç. Öteki ölçüm okumaları durduruluyor (hat ona
  // kalsın; 3 aday birlikte ölçülürken hız bölündüğü için 4K hiç çıtayı geçemiyordu). Keşfin bıraktığı
  // yerden (16. MB) devam ediliyor: henüz inmemiş kısım, yani hız gerçek; ölçerken videonun başı da iniyor
  // (seçilirse açılışta hazır: eskiden dosyanın çeyreğinden okunuyordu, açılışa faydası yoktu).
  app.post('/api/torrent-dogrula', wrap(async (req, res) => {
    const { type, id, streamId } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz' });
    const s = streamCache.get(`${type}|${id}`)?.streams.find((x) => x.streamId === streamId);
    if (s?.kind !== 'torrent') return res.status(404).json({ error: 'Yok' });
    olcumleriDurdur(s.infoHash);
    isit(s, DOGRULAMA_BAYT, { bas: OLCUM_BAYT_TS, sureMs: 20_000 });
    res.json({ ok: true });
  }));

  app.post('/api/rooms', wrap(async (req, res) => {
    const { type, id, streamId, olcumler } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    const { meta, streams } = await loadStreams(type, id);
    if (!streams.some((s) => s.streamId === streamId)) return res.status(400).json({ error: 'Stream bulunamadı' });
    const { room, creatorToken } = rooms.create({
      type, contentId: id, meta, streams, hostStreamId: streamId, settings: { ...config.get().defaults, relayEnabled: false, relay4k: false }, // relay kapalı (kod duruyor)
    });
    log.info('Oda açıldı', { roomId: room.id, content: id });
    // "Oda aç" ekranında ölçülen kaynaklar odaya (kaynak zayıflarsa yeniden ölçmeden geçiş için).
    if (Array.isArray(olcumler)) {
      room.olcumler = new Map();
      for (const o of olcumler.slice(0, 40)) {
        if (!/^[0-9a-f]{40}$/.test(String(o?.infoHash || ''))) continue;
        room.olcumler.set(o.infoHash, {
          downMbps: Number(o.downMbps) || 0, peers: Number(o.peers) || 0, alive: (Number(o.downMbps) || 0) > 0.1, at: Date.now(),
        });
      }
    }
    onRoomCreated(room);
    // Açılış tamponu önceden: oda açılır açılmaz (oynatıcı daha yüklenirken) izlenecek yerin 128 MB'ı
    // indirilmeye başlıyor; ölçüm okumaları duruyor. Oynatıcı açılışta ~30 sn'lik görüntü biriktiriyor,
    // aramada yalnız baştan 16 MB iniyordu: odaya girince tampon sıfırdan doluyor, video 25 sn bekliyordu.
    // Kaldığı yerden açılıyorsa (kaldigiYer) oradan.
    olcumleriDurdur();
    const secilenAkis = streams.find((s) => s.streamId === streamId);
    if (secilenAkis?.kind === 'torrent') {
      const MB = 1024 * 1024;
      const sure = Number(meta?.sureSn) || 0;
      const boy = Number(secilenAkis.sizeBytes) || 0;
      const konum = Number(room.playback?.position) || 0;
      const bas = sure && boy && konum > 0 ? Math.max(0, Math.floor(((konum / sure) * boy) / MB) * MB - 8 * MB) : 0;
      isit(secilenAkis, 128 * MB, { bas, sureMs: 60_000, olcum: false });
    }
    // Seçim ekranında önceden açılan diğer torrent'ler hemen kapansın: seçilen videoyla hızı
    // paylaşıp açılışını geciktiriyorlardı (temizlik ayarını ve 5 sn'lik turu beklemeden).
    const secilen = streams.find((s) => s.streamId === streamId)?.infoHash;
    const entry = streamCache.get(`${type}|${id}`);
    for (const hash of entry?.isitildi || []) {
      if (hash !== secilen) stremioLocal.removeTorrent({ infoHash: hash }).catch(() => {});
    }
    res.json({
      roomId: room.id,
      creatorToken,
      roomUrl: `${publicBase}/room/${room.id}#${new URLSearchParams({ host: creatorToken, name: config.get().nickname })}`,
    });
  }));

  // "İzlemeye devam" oynat düğmesi: en son açılan kaynakla odayı doğrudan açar (kaynak aramaz, ölçmez).
  // Dizide son izlenen bölüm. Kayıtlı kaynak yoksa 404 { error: 'akisYok' }: arayüz detay sayfasına gider.
  app.post('/api/rooms/devam', wrap(async (req, res) => {
    const { type, id } = req.body || {};
    if (!validContent(type, id)) return res.status(400).json({ error: 'Geçersiz içerik' });
    const kayit = gecmis.akisAl(type, String(id).split(':')[0]);
    if (!kayit?.stream || !validContent(type, kayit.contentId)) return res.status(404).json({ error: 'akisYok' });
    const meta = await addons.meta(type, kayit.contentId).catch(() => null) || { name: kayit.contentId };
    const akis = kayit.stream;
    const { room, creatorToken } = rooms.create({
      type, contentId: kayit.contentId, meta, streams: [akis], hostStreamId: akis.streamId,
      settings: { ...config.get().defaults, relayEnabled: false, relay4k: false },
    });
    log.info('Oda açıldı (izlemeye devam)', { roomId: room.id, content: kayit.contentId });
    onRoomCreated(room);
    olcumleriDurdur();
    const MB = 1024 * 1024;
    const sure = Number(meta?.sureSn) || 0;
    const boy = Number(akis.sizeBytes) || 0;
    const konum = Number(room.playback?.position) || 0;
    const bas = sure && boy && konum > 0 ? Math.max(0, Math.floor(((konum / sure) * boy) / MB) * MB - 8 * MB) : 0;
    isit(akis, 128 * MB, { bas, sureMs: 60_000, olcum: false });
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

  // Ana sayfadaki "Açık odalar" satırı: kişi olan odalar, giriş adresiyle (konuk bağlantısı).
  app.get('/api/acik-odalar', (req, res) => {
    // Boş (içinde kimse olmayan) odalar da listelenir: "Odadan çık (oda açık kalsın)" diyen host'un odası, geri gelene ya da
    // oda zaman aşımına (rooms.js emptyTtlMs) kadar buradan bulunabilsin.
    res.json(rooms.list().map((r) => ({
      id: r.id,
      name: r.meta?.name || r.contentId,
      poster: r.meta?.poster || null,
      users: r.connectedUsers().length,
      playing: !r.playback.paused,
      url: `${publicBase}/room/${r.id}`,
    })));
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
