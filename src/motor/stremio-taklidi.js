// Stremio'nun yayın sunucusunun (127.0.0.1:11470) bizim kullandığımız adreslerini TorrServer'la
// karşılayan ara katman. Sunucu, relay, masaüstü uygulaması (stremio-vekil.cjs) ve tarayıcıdaki
// host hep bu adresleri kullanıyor; motor değişince hiçbirine dokunmak gerekmiyor.
//
//   GET  /settings               "açık mı" denetimi (POST: Stremio ayarı, yok sayılıyor)
//   GET  /stats.json             açık torrent'ler
//   GET  /<hash>/stats.json      torrent istatistiği (peers, downloadSpeed, uploaded …)
//   GET  /<hash>/remove          torrent'i kapat
//   POST /<hash>/create          torrent'i ek tracker'larla aç
//   GET  /<hash>/<sıra>?tr=…     video dosyası (Range)
//   GET  /opensubHash?videoUrl=  OpenSubtitles hash'i
//
// Uyumlu mod (/hlsv2, ffmpeg ile dönüştürme) henüz yok: 404 dönüyor (plan: Faz 4).

import http from 'node:http';

const DOSYA = /^\/([0-9a-f]{40})\/(-1|\d+)$/i;
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i;
const METADATA_MS = 120_000;
const AKTARILAN = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified'];

// Torrentio'nun "fileIdx"i torrent'teki sırayı dolgu (pad) dosyalarıyla birlikte sayıyor,
// TorrServer dolgu dosyalarını listelemiyor: sıra kayabiliyor (ölçümde 4 numaralı dosya
// TorrServer'da 2 numaraydı). Önce dosya adıyla eşleştiriliyor; ad yoksa sıra bir video
// dosyasına denk geliyorsa o, gelmiyorsa en büyük video.
export function dosyaSec(dosyalar, idx, ad) {
  if (!dosyalar?.length) return null;
  const sirali = [...dosyalar].sort((a, b) => a.id - b.id);
  const sonAd = (f) => String(f.path || '').split('/').pop();
  if (ad) {
    const f = sirali.find((x) => sonAd(x) === ad);
    if (f) return f;
  }
  if (idx >= 0 && sirali[idx] && VIDEO.test(sonAd(sirali[idx]))) return sirali[idx];
  const videolar = sirali.filter((x) => VIDEO.test(sonAd(x)));
  return (videolar.length ? videolar : sirali).reduce((a, b) => (b.length > a.length ? b : a));
}

// TorrServer durumu -> Stremio'nun stats.json biçimi (yalnız bizim okuduğumuz alanlar).
export function istatistik(t) {
  if (!t) return null;
  return {
    infoHash: t.hash,
    name: t.name || null,
    peers: Number(t.active_peers) || 0,
    swarmSize: Number(t.total_peers) || 0,
    downloadSpeed: Number(t.download_speed) || 0,
    uploadSpeed: Number(t.upload_speed) || 0,
    downloaded: Number(t.bytes_read_data) || 0,
    uploaded: Number(t.bytes_written_data) || 0,
    streamProgress: null,
    // Stremio'ya özgü "tamamını indir" listesi; TorrServer'da yok (birikme denetimi boş görsün).
    selections: [],
  };
}

// OpenSubtitles hash: boyut + ilk ve son 64 KB'ın 64 bit küçük-sonlu toplamı (mod 2^64).
export function opensubHash(boyut, bas, son) {
  let toplam = BigInt(boyut);
  for (const parca of [bas, son]) {
    for (let i = 0; i + 8 <= parca.length; i += 8) toplam += parca.readBigUInt64LE(i);
  }
  return (toplam & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

export function createStremioTaklidi({ ts, port = 11470, log, dosyaAdi = () => null }) {
  const ekleniyor = new Map(); // hash -> ekleme sözü (aynı torrent iki kez eklenmesin)
  const secilen = new Map(); // `${hash}/${sıra}` -> { id, length }
  let sunucu = null;

  const trackerlar = (kaynaklar) => kaynaklar
    .filter((s) => typeof s === 'string' && s.startsWith('tracker:'))
    .map((s) => s.slice('tracker:'.length));

  async function ekle(ih, tr) {
    if (!ekleniyor.has(ih)) ekleniyor.set(ih, ts.ekle(ih, tr).finally(() => ekleniyor.delete(ih)));
    return ekleniyor.get(ih);
  }

  // Torrent'i (gerekirse) açar, metadata gelince istenen dosyayı seçer. ad: adresteki f= ya da kayıt.
  async function dosya(ih, idx, tr, ad) {
    const anahtar = `${ih}/${idx}`;
    let t = await ts.torrent(ih);
    if (secilen.has(anahtar) && t) return secilen.get(anahtar);
    if (!t) await ekle(ih, tr);
    const son = Date.now() + METADATA_MS;
    while (!t?.file_stats?.length) {
      if (Date.now() > son) return null;
      await new Promise((r) => setTimeout(r, 300));
      t = await ts.torrent(ih);
    }
    const f = dosyaSec(t.file_stats, idx, ad || dosyaAdi(ih, idx));
    secilen.set(anahtar, f);
    return f;
  }

  function json(res, kod, veri) {
    const govde = JSON.stringify(veri);
    res.writeHead(kod, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(govde) });
    res.end(govde);
  }

  async function akit(req, res, ih, idx, adres) {
    const f = await dosya(ih, idx, trackerlar(adres.searchParams.getAll('tr')), adres.searchParams.get('f'));
    if (!f) return json(res, 504, { error: 'metadata' });
    const basliklar = {};
    if (req.headers.range) basliklar.range = req.headers.range;
    const ust = http.request(ts.akisAdresi(ih, f.id), { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: basliklar }, (up) => {
      const giden = {};
      for (const b of AKTARILAN) if (up.headers[b]) giden[b] = up.headers[b];
      res.writeHead(up.statusCode || 502, giden);
      up.pipe(res);
    });
    ust.on('error', (err) => {
      log.warn('TorrServer akışı başarısız', { infoHash: ih, error: err.message });
      if (!res.headersSent) json(res, 502, { error: 'motor' });
      else res.destroy();
    });
    res.on('close', () => ust.destroy());
    ust.end();
  }

  async function opensub(res, videoUrl) {
    const oku = async (aralik) => {
      const r = await fetch(videoUrl, { headers: { range: aralik }, signal: AbortSignal.timeout(60_000) });
      return { buf: Buffer.from(await r.arrayBuffer()), toplam: Number(String(r.headers.get('content-range') || '').split('/')[1]) || null };
    };
    try {
      const ilk = await oku('bytes=0-65535');
      if (!ilk.toplam || ilk.toplam < 131072) return json(res, 200, { result: null });
      const son = await oku(`bytes=${ilk.toplam - 65536}-${ilk.toplam - 1}`);
      json(res, 200, { result: { hash: opensubHash(ilk.toplam, ilk.buf, son.buf), size: ilk.toplam } });
    } catch {
      json(res, 200, { result: null });
    }
  }

  async function isle(req, res) {
    const adres = new URL(req.url, 'http://127.0.0.1');
    const yol = adres.pathname;
    if (yol === '/settings') {
      if (req.method === 'POST') req.resume();
      return json(res, 200, { options: [], values: { serverVersion: 'torrserver', motor: 'torrserver' } });
    }
    if (yol === '/stats.json') {
      const liste = await ts.torrentler().catch(() => []);
      return json(res, 200, Object.fromEntries(liste.map((t) => [t.hash, istatistik(t)])));
    }
    if (yol === '/opensubHash') return opensub(res, adres.searchParams.get('videoUrl'));
    let m = yol.match(/^\/([0-9a-f]{40})\/(stats\.json|remove|create)$/i);
    if (m) {
      const ih = m[1].toLowerCase();
      if (m[2] === 'stats.json') return json(res, 200, istatistik(await ts.torrent(ih).catch(() => null)));
      if (m[2] === 'remove') {
        await ts.kapat(ih);
        for (const k of secilen.keys()) if (k.startsWith(`${ih}/`)) secilen.delete(k);
        return json(res, 200, {});
      }
      let govde = '';
      for await (const p of req) govde += p;
      let kaynaklar = [];
      try { kaynaklar = JSON.parse(govde)?.peerSearch?.sources || []; } catch { /* */ }
      await ekle(ih, trackerlar(kaynaklar));
      return json(res, 200, {});
    }
    m = yol.match(DOSYA);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) return akit(req, res, m[1].toLowerCase(), Number(m[2]), adres);
    return json(res, 404, { error: 'yok' });
  }

  return {
    async baslat() {
      sunucu = http.createServer((req, res) => {
        isle(req, res).catch((err) => {
          log.warn('Stremio taklidi isteği başarısız', { url: req.url, error: err.message });
          if (!res.headersSent) json(res, 500, { error: 'ic' });
          else res.destroy();
        });
      });
      await new Promise((resolve, reject) => {
        sunucu.once('error', reject);
        sunucu.listen(port, '127.0.0.1', resolve);
      });
      log.info('Stremio taklidi dinliyor (motor: TorrServer)', { port });
    },
    durdur: () => sunucu?.close(),
    port: () => sunucu?.address()?.port,
  };
}
