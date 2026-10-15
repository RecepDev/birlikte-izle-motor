// Arka plan indirmesi seçenekleri (kullanıcı): hangi kalite, boyut, HDR, dil, Türkçe altyazı, Blu-ray.
// `sor`: indirmeye basınca bu seçenekler sorulsun mu (Ayarlar'dan kapatılabilir; kapalıysa kayıtlı seçenekler sessizce uygulanır).
// data/indirme-secenek.json. Seçici: public/js/shared/kaynak-sec.js indirmeSec.
import fs from 'node:fs';
import path from 'node:path';
import { INDIRME_VARSAYILAN } from '../public/js/shared/kaynak-sec.js';
import { DIL_KODLARI } from '../public/js/shared/diller.js';

const KALITE = ['', '2160p', '1080p', '720p', '480p'];
const BOYUT = ['fark', 'kucuk', 'buyuk'];
const UC = ['fark', 'olsun', 'olmasin'];
const TR = ['fark', 'olsun'];

// Bilinmeyen ya da geçersiz alanlar varsayılana döner; sonuç hep tam bir nesne.
export function seceneklerDogrula(girdi) {
  const g = girdi && typeof girdi === 'object' ? girdi : {};
  const sec = (v, liste, yedek) => (liste.includes(v) ? v : yedek);
  const max = Number(g.boyutMaxGb);
  return {
    sor: typeof g.sor === 'boolean' ? g.sor : INDIRME_VARSAYILAN.sor,
    kalite: sec(g.kalite, KALITE, ''),
    boyut: sec(g.boyut, BOYUT, 'fark'),
    boyutMaxGb: Number.isFinite(max) && max > 0 && max <= 2000 ? Math.round(max * 10) / 10 : null,
    hdr: sec(g.hdr, UC, 'fark'),
    // Eski değerler: 'turkce' -> 'tr'; 'coklu' -> fark etmez.
    dil: sec(g.dil === 'turkce' ? 'tr' : g.dil, ['fark', ...DIL_KODLARI], 'fark'),
    diller: Array.isArray(g.diller) ? [...new Set(g.diller.filter((k) => DIL_KODLARI.includes(k)))] : (DIL_KODLARI.includes(g.dil === 'turkce' ? 'tr' : g.dil) ? [g.dil === 'turkce' ? 'tr' : g.dil] : []),
    favoriDiller: Array.isArray(g.favoriDiller) ? [...new Set(g.favoriDiller.filter((k) => DIL_KODLARI.includes(k)))] : INDIRME_VARSAYILAN.favoriDiller,
    trAltyazi: sec(g.trAltyazi, TR, 'fark'),
    bluray: sec(g.bluray, UC, 'fark'),
  };
}

export function createIndirmeSecenek({ file, log }) {
  let veri = seceneklerDogrula(null);
  try {
    veri = seceneklerDogrula(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch { /* ilk çalıştırma */ }

  return {
    oku: () => ({ ...veri }),
    yaz(girdi) {
      veri = seceneklerDogrula({ ...veri, ...(girdi || {}) });
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(veri, null, 1));
      } catch (err) {
        log?.warn('İndirme seçenekleri yazılamadı', { error: err.message });
      }
      return { ...veri };
    },
  };
}
