// İzleme geçmişi (host'un): oda açılan ya da odada geçilen film/bölümler.
// "Film ara" ekranında "Daha önce açtıkların" ve bölümlerdeki "izlendi" işareti buradan.
// Diziler tek kayıtta toplanıyor: hangi bölümler açıldıysa listede.

import fs from 'node:fs';
import path from 'node:path';

const EN_FAZLA = 60;

export function createGecmis({ file, log }) {
  let kayitlar = [];
  try {
    kayitlar = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(kayitlar)) kayitlar = [];
  } catch { /* ilk çalıştırma */ }

  function yaz() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(kayitlar, null, 1));
    } catch (err) {
      log.warn('Geçmiş yazılamadı', { error: err.message });
    }
  }

  return {
    // type: movie|series, contentId: "tt123" ya da "tt123:1:3"
    ekle({ type, contentId, meta }) {
      const [id, sezon, bolum] = String(contentId).split(':');
      if (!id) return;
      let k = kayitlar.find((x) => x.id === id && x.type === type);
      if (!k) {
        k = { type, id, name: id, poster: null, watched: [] };
        kayitlar.push(k);
      }
      // Dizide meta adı bölümü de içeriyor ("Silo S03E01 · …"): dizi adını ayıklıyoruz.
      const ad = String(meta?.name || '').replace(/\s+S\d+E\d+.*$/, '').trim();
      if (ad) k.name = ad;
      if (meta?.poster) k.poster = meta.poster;
      if (sezon && bolum && !k.watched.includes(`${sezon}:${bolum}`)) k.watched.push(`${sezon}:${bolum}`);
      k.last = type === 'series' && sezon ? `${sezon}:${bolum}` : null;
      k.at = Date.now();
      kayitlar.sort((a, b) => b.at - a.at);
      kayitlar = kayitlar.slice(0, EN_FAZLA);
      yaz();
    },
    liste: () => kayitlar,
    izlenenler: (id) => kayitlar.find((x) => x.id === id && x.type === 'series')?.watched || [],
  };
}
