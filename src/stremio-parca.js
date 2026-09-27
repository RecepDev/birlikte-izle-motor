// Stremio'dan ucu açık aralığı ("bytes=X-") kapalı parçalar halinde okuyup tek cevap olarak
// akıtır. Stremio ucu açık her istekte dosyayı "tamamını indir" listesine bir kopya daha
// ekliyor ve silmiyor; kopyalar biriktikçe indirme yavaşlıyor. Kapalı aralıkta eklemiyor.
// (Masaüstü uygulamasındaki karşılığı: masaustu/electron/stremio-vekil.cjs.)

import http from 'node:http';

// Büyük parça: Stremio bir isteğin aralığındaki parçaları öncelikli indiriyor. 48 MB (~15 sn)
// küçük kalıyordu; hız yüksekken bile ilerisi hazırlanmıyor, "2 sn hazır"da kalıyordu. 1 GB
// (~5 dk) eski ucu açık istek kadar ileriyi kapsıyor, yine de birikme yapmıyor.
const PARCA = 1024 * 1024 * 1024;
export const ACIK_ARALIK = /^bytes=(\d+)-$/;
// Tek dosya adresi: /<infoHash>/<sıra> (HLS, stats vb. değil).
export const dosyaYolu = (yol) => /^\/[0-9a-f]{40}\/[^/?]+(\?|$)/i.test(yol);

const gorulen = new Set();
// Dosyanın ilk isteği olduğu gibi geçmeli (Stremio'nun arkadan indirmesi için bir kayıt yeterli).
export function ilkIstekMi(yol) {
  const anahtar = yol.split('?')[0];
  if (gorulen.has(anahtar)) return false;
  gorulen.add(anahtar);
  return true;
}

function iste(target, aralik) {
  return new Promise((resolve, reject) => {
    const r = http.request(target, { method: 'GET', headers: { range: aralik } }, resolve);
    r.on('error', reject);
    r.end();
  });
}

// Dosya boyu (bytes=0-0 ile, kapalı aralık): ilk parça dosya sonunu aşmasın. Dosyanın son
// kısmından okunurken (MKV dizini sonda) parça sonu dosyayı aşınca Stremio 416 dönüyordu,
// telefon oynatıcısı takılı kalıyordu.
const boylar = new Map();
async function dosyaBoyu(target) {
  const anahtar = target.split('?')[0];
  if (boylar.has(anahtar)) return boylar.get(anahtar);
  const up = await iste(target, 'bytes=0-0');
  up.resume();
  const boy = Number(String(up.headers['content-range'] || '').split('/')[1]) || null;
  if (boy) boylar.set(anahtar, boy);
  return boy;
}

// target: tam Stremio adresi; bas: istenen başlangıç; acik: istemci aralık istedi mi.
export async function parcaliAkit(target, bas, acik, res, { onBytes = () => {} } = {}) {
  let konum = bas;
  let toplam = await dosyaBoyu(target).catch(() => null);
  if (toplam && konum >= toplam) {
    res.writeHead(416, { 'content-range': `bytes */${toplam}` });
    res.end();
    return;
  }
  let basladi = false;
  let kapandi = false;
  let simdiki = null;
  res.on('close', () => {
    kapandi = true;
    simdiki?.destroy();
  });
  while (!kapandi && (toplam === null || konum < toplam)) {
    const son = toplam === null ? konum + PARCA - 1 : Math.min(toplam - 1, konum + PARCA - 1);
    const up = await iste(target, `bytes=${konum}-${son}`);
    simdiki = up;
    if (!basladi) {
      basladi = true;
      if (up.statusCode !== 206) {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
        return;
      }
      toplam ||= Number(String(up.headers['content-range'] || '').split('/')[1]) || null;
      const baslik = {
        'content-type': up.headers['content-type'] || 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
      };
      if (toplam) {
        baslik['content-length'] = String(toplam - konum);
        if (acik) baslik['content-range'] = `bytes ${konum}-${toplam - 1}/${toplam}`;
      }
      res.writeHead(acik ? 206 : 200, baslik);
    }
    const gelen = await new Promise((resolve) => {
      let n = 0;
      up.on('data', (veri) => {
        n += veri.length;
        onBytes(veri.length);
        if (!res.write(veri)) {
          up.pause();
          res.once('drain', () => up.resume());
        }
      });
      up.on('end', () => resolve(n));
      up.on('error', () => resolve(n));
      up.on('close', () => resolve(n));
    });
    if (!gelen || !toplam) break;
    konum += gelen;
  }
  if (!kapandi) res.end();
}
