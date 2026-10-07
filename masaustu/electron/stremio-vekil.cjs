// mpv ile Stremio'nun yayın sunucusu arasında küçük bir ara katman (yalnızca bu bilgisayarda).
//
// Sorun: Stremio, ucu açık her aralık isteğinde ("Range: bytes=X-") dosyayı "tamamını indir"
// listesine bir kez daha ekliyor ve bunları hiç silmiyor. mpv her ileri-geri sarmada, her
// yeniden bağlanmada böyle bir istek yapıyor; kopyalar birikiyor, Stremio parça seçerken hepsini
// dolaştığı için indirme yavaşlıyor.
//
// Çözüm: Stremio'ya ucu kapalı parçalar halinde soruyoruz ("bytes=X-Y"). Stremio kapalı
// aralıkta listeye ekleme yapmıyor. mpv'ye ise tek, kesintisiz bir cevap gidiyor. Her dosyanın
// ilk isteği olduğu gibi geçiyor: Stremio'nun dosyanın geri kalanını arkadan indirmesi için
// bir tane kayıt yeterli ve faydalı.

const http = require('node:http');

const STREMIO = { host: '127.0.0.1', port: 11470 };
// Parça boyu = "Önünü hazırla" süresi kadar video (+%25, +30 sn). Stremio istenen parçanın
// tamamını tam hızla indiriyor: sabit 4 GB (4K'da ~20 dk) her açılışta/sarmada gigabaytlarca
// indirip evdeki interneti tıkıyordu; çok küçük parça da ilerisini hazırlatmıyordu.
const MB = 1024 * 1024;
const PARCA_EN_AZ = 128 * MB;
const PARCA_EN_COK = 4 * 1024 * MB;
let videoSuresi = null; // sn (mpv'den)
let onbellekSn = 180;
function parcaBoyu(toplam) {
  if (!toplam || !videoSuresi) return 256 * MB;
  const saniyeBasi = toplam / videoSuresi;
  return Math.round(Math.min(PARCA_EN_COK, Math.max(PARCA_EN_AZ, saniyeBasi * (onbellekSn * 1.25 + 30))));
}
function ayarla({ sure, onbellek } = {}) {
  if (Number.isFinite(sure) && sure > 0) videoSuresi = sure;
  if (Number.isFinite(onbellek) && onbellek > 0) onbellekSn = onbellek;
}
const ACIK_ARALIK = /^bytes=(\d+)-$/;
// Bağlantıya ait başlıklar mpv'ye aktarılmaz. Motorun "connection: keep-alive" cevabı mpv'ye
// geçince mpv'nin FFmpeg'i (2026 sürümü) sarmada yeni bağlantı açmak yerine bu cevabın kalanını
// indirip atıyordu ("Soft-seeking ... by draining"): MKV'nin sonundaki dizine (Cues) giderken
// dosyanın tamamı (ör. 6.7 GB) sırayla iniyor, veri 60 Mbps gelirken video 00:00'da kalıyordu.
const BAGLANTI_BASLIKLARI = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const aktarilan = (basliklar) => Object.fromEntries(Object.entries(basliklar).filter(([k]) => !BAGLANTI_BASLIKLARI.has(k.toLowerCase())));

let sunucu = null;
let port = null;
const gorulen = new Set(); // ilk (ucu açık) isteği geçmiş dosyalar

function yukari(yol, aralik, method = 'GET') {
  return new Promise((resolve, reject) => {
    // enginefs-prio: Stremio bu okumanın parçalarını diğer her şeyden önce indirsin (izlenen
    // yer; ileri atlayınca yeni yere hemen odaklansın).
    const istek = http.request({ ...STREMIO, path: yol, method, headers: { ...(aralik ? { Range: aralik } : {}), 'enginefs-prio': '10' } }, resolve);
    istek.on('error', reject);
    istek.end();
  });
}

// Yalnızca tek dosya adresleri (/<infoHash>/<sıra>); HLS, stats vb. olduğu gibi geçer.
const dosyaYolu = (yol) => /^\/[0-9a-f]{40}\/[^/?]+(\?|$)/i.test(yol);

async function isle(req, res) {
  const yol = req.url;
  const aralik = req.headers.range;
  const eslesme = aralik && ACIK_ARALIK.exec(aralik);
  const anahtar = yol.split('?')[0];
  // Parçalamaya gerek olmayanlar: dosya değil, HEAD, kapalı aralık ya da dosyanın ilk isteği.
  if (req.method !== 'GET' || !dosyaYolu(yol) || (aralik && !eslesme) || !gorulen.has(anahtar)) {
    if (dosyaYolu(yol) && req.method === 'GET') gorulen.add(anahtar);
    const cevap = await yukari(yol, aralik, req.method);
    res.writeHead(cevap.statusCode, aktarilan(cevap.headers));
    cevap.pipe(res);
    res.on('close', () => cevap.destroy());
    return;
  }
  let konum = eslesme ? Number(eslesme[1]) : 0;
  let kapandi = false;
  let simdiki = null;
  res.on('close', () => {
    kapandi = true;
    simdiki?.destroy();
  });
  let ilk = true;
  let toplam = null;
  while (!kapandi && (toplam === null || konum < toplam)) {
    const parca = parcaBoyu(toplam);
    const son = toplam === null ? konum + parca - 1 : Math.min(toplam - 1, konum + parca - 1);
    const cevap = await yukari(yol, `bytes=${konum}-${son}`);
    simdiki = cevap;
    if (ilk) {
      ilk = false;
      if (cevap.statusCode !== 206) {
        // Beklenmedik cevap: olduğu gibi ilet.
        res.writeHead(cevap.statusCode, aktarilan(cevap.headers));
        cevap.pipe(res);
        return;
      }
      toplam = Number(String(cevap.headers['content-range'] || '').split('/')[1]) || null;
      const baslik = {
        'Content-Type': cevap.headers['content-type'] || 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      };
      if (toplam) {
        baslik['Content-Length'] = String(toplam - konum);
        if (aralik) baslik['Content-Range'] = `bytes ${konum}-${toplam - 1}/${toplam}`;
      }
      res.writeHead(aralik ? 206 : 200, baslik);
    }
    // Parçayı akıt; mpv yavaş okursa (arabelleği dolu) bekle.
    const gelen = await new Promise((resolve) => {
      let n = 0;
      cevap.on('data', (veri) => {
        n += veri.length;
        if (!res.write(veri)) {
          cevap.pause();
          res.once('drain', () => cevap.resume());
        }
      });
      cevap.on('end', () => resolve(n));
      cevap.on('error', () => resolve(n));
      cevap.on('close', () => resolve(n));
    });
    if (!gelen) break;
    konum += gelen;
    if (!toplam) break;
  }
  if (!kapandi) res.end();
}

// Stremio adresini ara katman adresine çevirir (başka adresleri olduğu gibi bırakır).
async function vekilAdres(url) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):11470\//.test(url || '')) return url;
  if (!sunucu) {
    sunucu = http.createServer((req, res) => {
      isle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    await new Promise((resolve) => sunucu.listen(0, '127.0.0.1', resolve));
    port = sunucu.address().port;
  }
  return url.replace(/^http:\/\/(127\.0\.0\.1|localhost):11470/, `http://127.0.0.1:${port}`);
}

module.exports = { vekilAdres, ayarla, parcaBoyu, aktarilan };
