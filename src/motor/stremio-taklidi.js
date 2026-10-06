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

import crypto from 'node:crypto';
import http from 'node:http';

const DOSYA = /^\/([0-9a-f]{40})\/(-1|\d+)$/i;
const VIDEO = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i;
const METADATA_MS = 120_000;
const AKTARILAN = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified'];
const MIME = { mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', mov: 'video/quicktime' };

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

const YEREL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// onbellek: src/motor/onbellek.js (verilmezse her şey doğrudan TorrServer'dan).
export function createStremioTaklidi({ ts, port = 11470, log, dosyaAdi = () => null, onbellek = null }) {
  const kimlik = crypto.randomBytes(8).toString('hex'); // 127.0.0.1'e cevap verenin biz olduğunu doğrulamak için
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
      await new Promise((r) => setTimeout(r, 100)); // metadata gelir gelmez başlasın
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
    const tr = trackerlar(adres.searchParams.getAll('tr'));
    const ad = adres.searchParams.get('f');
    if (onbellek?.acik()) return onbellekliAkit(req, res, ih, idx, tr, ad);
    const f = await dosya(ih, idx, tr, ad);
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

  // Önbellekli akış: istenen aralığın baştaki önbellekte olan blokları diskten (internete, TorrServer'a
  // gitmeden), kalanı TorrServer'dan; geçerken tam bloklar önbelleğe yazılıyor.
  async function onbellekliAkit(req, res, ih, idx, tr, ad) {
    // Dosya seçimi daha önce yapıldıysa TorrServer'ı beklemeden başla (torrent arkada açılıyor:
    // önbellekteki kısım bitince lazım olacak).
    const anahtar = `${idx}|${ad || ''}`;
    let f = onbellek.secim(ih, anahtar);
    if (f) {
      dosya(ih, idx, tr, ad).catch(() => {});
    } else {
      f = await dosya(ih, idx, tr, ad);
      if (!f) return json(res, 504, { error: 'metadata' });
      onbellek.secimKaydet(ih, anahtar, f);
    }
    const boy = f.length;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    let bas = 0;
    let son = boy - 1;
    if (m && m[1] === '' && m[2] !== '') bas = Math.max(0, boy - Number(m[2])); // "son N bayt"
    else if (m) {
      bas = Number(m[1] || 0);
      if (m[2] !== '') son = Math.min(boy - 1, Number(m[2]));
    }
    if (bas >= boy || bas > son) {
      res.writeHead(416, { 'content-range': `bytes */${boy}` });
      return res.end();
    }
    const uzanti = String(f.path || '').split('.').pop().toLowerCase();
    const baslik = { 'content-type': MIME[uzanti] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(son - bas + 1) };
    if (m) baslik['content-range'] = `bytes ${bas}-${son}/${boy}`;
    res.writeHead(m ? 206 : 200, baslik);
    if (req.method === 'HEAD') return res.end();

    let kapandi = false;
    res.on('close', () => { kapandi = true; });
    const gonder = (veri) => new Promise((r) => {
      if (kapandi || res.write(veri)) return r();
      const devam = () => {
        res.off('drain', devam);
        res.off('close', devam);
        r();
      };
      res.on('drain', devam);
      res.on('close', devam);
    });

    const B = onbellek.blok;
    let konum = bas;
    while (konum <= son && !kapandi) {
      const no = Math.floor(konum / B);
      const veri = await onbellek.oku(ih, f.id, no, boy);
      if (!veri) break;
      const a = konum - no * B;
      const b = Math.min(veri.length, son - no * B + 1);
      await gonder(veri.subarray(a, b));
      konum = no * B + b;
    }
    if (konum > son || kapandi) return res.end();

    await new Promise((bitti) => {
      const ust = http.request(ts.akisAdresi(ih, f.id), { headers: { range: `bytes=${konum}-${son}` } }, (up) => {
        if (up.statusCode !== 206 && up.statusCode !== 200) {
          up.resume();
          res.destroy();
          return bitti();
        }
        let pos = konum; // up'tan gelen sıradaki baytın dosyadaki yeri
        let blokNo = Math.ceil(konum / B); // önbelleğe yazılacak ilk tam blok (baştaki yarım blok yazılmaz)
        let parcalar = [];
        let toplanan = 0;
        up.on('data', (p) => {
          if (!res.write(p)) {
            up.pause();
            res.once('drain', () => up.resume());
          }
          let off = 0;
          while (off < p.length) {
            const blokBas = blokNo * B;
            if (pos + off < blokBas) {
              off = Math.min(p.length, blokBas - pos);
              continue;
            }
            const blokSon = blokBas + onbellek.blokBoyu(boy, blokNo);
            const al = Math.min(p.length - off, blokSon - (pos + off));
            parcalar.push(p.subarray(off, off + al));
            toplanan += al;
            off += al;
            if (blokBas + toplanan === blokSon) {
              onbellek.yaz(ih, f.id, blokNo, Buffer.concat(parcalar));
              parcalar = [];
              toplanan = 0;
              blokNo++;
            }
          }
          pos += p.length;
        });
        up.on('end', () => {
          res.end();
          bitti();
        });
        up.on('error', () => {
          res.destroy();
          bitti();
        });
        up.on('close', bitti);
      });
      ust.on('error', (err) => {
        log.warn('TorrServer akışı başarısız', { infoHash: ih, error: err.message });
        res.destroy();
        bitti();
      });
      res.on('close', () => ust.destroy());
      ust.end();
    });
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
      return json(res, 200, { options: [], values: { serverVersion: 'torrserver', motor: 'torrserver', kimlik } });
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
        // "::" üzerinde dinliyoruz (aşağıya bak) ama yalnız bu bilgisayardan gelen istekler.
        if (!YEREL.has(req.socket.remoteAddress)) {
          res.writeHead(403);
          res.end();
          return;
        }
        isle(req, res).catch((err) => {
          log.warn('Stremio taklidi isteği başarısız', { url: req.url, error: err.message });
          if (!res.headersSent) json(res, 500, { error: 'ic' });
          else res.destroy();
        });
      });
      // "::" (çift yığın): Windows'ta 127.0.0.1'e bağlanmak, Stremio "::" üzerinde dinlerken bile hata
      // vermiyor ve 127.0.0.1 trafiğini Stremio'dan çalıyordu (denendi). "::" çakışınca EADDRINUSE veriyor.
      await new Promise((resolve, reject) => {
        sunucu.once('error', reject);
        sunucu.listen({ port, host: '::', ipv6Only: false }, resolve);
      }).catch(async (err) => {
        if (err.code !== 'EAFNOSUPPORT' && err.code !== 'EADDRNOTAVAIL') throw err;
        await new Promise((resolve, reject) => { sunucu.once('error', reject); sunucu.listen(port, '127.0.0.1', resolve); });
      });
      // Stremio yalnız IPv4'te dinliyorsa bağlanabiliyoruz ama 127.0.0.1 ona gidiyor: cevap verenin
      // biz olduğunu doğrula, değilse geri çekil (port dolu say).
      const cevap = await fetch(`http://127.0.0.1:${sunucu.address().port}/settings`, { signal: AbortSignal.timeout(3000) })
        .then((r) => r.json()).catch(() => null);
      if (cevap?.values?.kimlik !== kimlik) {
        sunucu.close();
        const err = new Error(`127.0.0.1:${port} başka bir programda (Stremio)`);
        err.code = 'EADDRINUSE';
        throw err;
      }
      log.info('Stremio taklidi dinliyor (motor: TorrServer)', { port });
    },
    durdur: () => sunucu?.close(),
    port: () => sunucu?.address()?.port,
  };
}
