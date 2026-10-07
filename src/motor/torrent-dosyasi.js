// Film bilgisini (.torrent dosyası) torrent'teki kişilerden beklemeden almak. itorrents gibi siteler
// .torrent dosyalarını kimliğe (infohash) göre saklıyor. Magnet her zamanki gibi hemen ekleniyor; dosya
// gelirse TorrServer'a da yükleniyor, aynı torrent'e birleşiyor.
//
// Ölçüm (2026-10-07, yeni açılmış TorrServer):
// - Yalnız magnet: metadata 9.4 sn.
// - Dosyayla: 0.26 sn.
// - itorrents.net 13 torrent'in 12'sinde dosyayı verdi, 25-190 ms'de.
//
// Gizlilik: site IP'yi ve istenen kimliği görüyor. Torrent'teki herkes ve tracker'lar bunu zaten
// görüyor. Panelden kapatılabiliyor (data/motor.json "siteden").
//
// Gelen dosyanın kimliği hesaplanıp istenenle karşılaştırılıyor; tutmayan atılıyor.
// İndirilen dosyalar diskte de saklanıyor: yeniden açılışta siteye de gidilmiyor.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export const SITELER = [
  (ih) => `https://itorrents.net/torrent/${ih.toUpperCase()}.torrent`,
  (ih) => `https://itorrents.org/torrent/${ih.toUpperCase()}.torrent`,
];
const EN_COK_DOSYA = 300;
const EN_COK_BAYT = 20 * 1024 * 1024;

// Bencode kök sözlüğündeki "info" değerinin [baş, son) bayt aralığı; bozuk ya da yarım veride null.
export function infoAraligi(b) {
  let i = 0;
  const uzunluk = () => {
    const iki = b.indexOf(0x3a, i);
    if (iki < 0) throw new Error('bozuk');
    const n = Number(b.subarray(i, iki).toString('latin1'));
    if (!Number.isInteger(n) || n < 0 || iki + 1 + n > b.length) throw new Error('bozuk');
    i = iki + 1;
    return n;
  };
  const atla = (derinlik = 0) => {
    if (derinlik > 64 || i >= b.length) throw new Error('bozuk');
    const c = b[i];
    if (c === 0x69) { // i<sayı>e
      const son = b.indexOf(0x65, i);
      if (son < 0) throw new Error('bozuk');
      i = son + 1;
    } else if (c === 0x6c || c === 0x64) { // l...e / d...e
      i++;
      while (i < b.length && b[i] !== 0x65) {
        if (c === 0x64) atla(derinlik + 1);
        atla(derinlik + 1);
      }
      if (i >= b.length) throw new Error('bozuk');
      i++;
    } else {
      const n = uzunluk(); // uzunluk() i'yi ':' sonrasına taşıyor; "i += uzunluk()" eski i'yi kullanırdı
      i += n;
    }
  };
  try {
    if (b?.[0] !== 0x64) return null;
    i = 1;
    while (i < b.length && b[i] !== 0x65) {
      const n = uzunluk();
      const anahtar = b.subarray(i, i + n).toString('latin1');
      i += n;
      const bas = i;
      atla();
      if (anahtar === 'info') return [bas, i];
    }
    return null;
  } catch {
    return null;
  }
}

export function torrentKimligi(b) {
  const ar = infoAraligi(b);
  return ar ? crypto.createHash('sha1').update(b.subarray(ar[0], ar[1])).digest('hex') : null;
}

// IPv4 ile: bu bilgisayarda Node'un fetch'i sitenin (Cloudflare) IPv6 adresine bağlanmaya çalışıp
// takılıyordu. Bir yönlendirme izleniyor (itorrents.org -> .net).
function indir(url, { zamanAsimi = 4000, yonlendirme = 1 } = {}) {
  return new Promise((resolve) => {
    const istek = https.get(url, { family: 4, headers: { 'user-agent': 'Mozilla/5.0' }, timeout: zamanAsimi }, (r) => {
      if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location && yonlendirme > 0) {
        r.resume();
        resolve(indir(new URL(r.headers.location, url).href, { zamanAsimi, yonlendirme: yonlendirme - 1 }));
        return;
      }
      if (r.statusCode !== 200) {
        r.resume();
        resolve(null);
        return;
      }
      const parcalar = [];
      let n = 0;
      r.on('data', (p) => {
        n += p.length;
        if (n > EN_COK_BAYT) {
          istek.destroy();
          resolve(null);
        } else parcalar.push(p);
      });
      r.on('end', () => resolve(Buffer.concat(parcalar)));
      r.on('error', () => resolve(null));
    });
    istek.on('timeout', () => istek.destroy());
    istek.on('error', () => resolve(null));
  });
}

export function createTorrentDosyasi({ klasor, log, indirImpl = indir, siteler = SITELER }) {
  const yol = (ih) => path.join(klasor, `${ih}.torrent`);

  function diskten(ih) {
    try {
      const b = fs.readFileSync(yol(ih));
      if (torrentKimligi(b) !== ih) return null;
      const simdi = new Date();
      fs.utimesSync(yol(ih), simdi, simdi); // en son kullanılan: temizlikte en son silinir
      return b;
    } catch {
      return null;
    }
  }

  function sakla(ih, b) {
    try {
      fs.mkdirSync(klasor, { recursive: true });
      fs.writeFileSync(yol(ih), b);
      const dosyalar = fs.readdirSync(klasor).filter((f) => f.endsWith('.torrent'));
      if (dosyalar.length <= EN_COK_DOSYA) return;
      dosyalar.map((f) => ({ f, t: fs.statSync(path.join(klasor, f)).mtimeMs }))
        .sort((a, b2) => a.t - b2.t)
        .slice(0, dosyalar.length - EN_COK_DOSYA)
        .forEach(({ f }) => fs.unlinkSync(path.join(klasor, f)));
    } catch (err) {
      log?.warn?.('Torrent dosyası saklanamadı', { error: err.message });
    }
  }

  return {
    // { veri, kaynak: 'disk' | 'site', ms } ya da null (hiçbir yerde yok / site cevap vermedi).
    async bul(ih) {
      const t0 = Date.now();
      const d = diskten(ih);
      if (d) return { veri: d, kaynak: 'disk', ms: Date.now() - t0 };
      for (const site of siteler) {
        const b = await indirImpl(site(ih));
        if (b && torrentKimligi(b) === ih) {
          sakla(ih, b);
          return { veri: b, kaynak: 'site', ms: Date.now() - t0 };
        }
      }
      return null;
    },
  };
}
