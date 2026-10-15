// Kütüphane (host'un): kişinin kendi eklediği film/diziler. Diske data/kutuphane.json olarak yazılıyor.
import fs from 'node:fs';
import path from 'node:path';

const EN_FAZLA = 500;

export function createKutuphane({ file, log }) {
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
      log?.warn('Kütüphane yazılamadı', { error: err.message });
    }
  }

  return {
    liste: () => kayitlar,
    var: (type, id) => kayitlar.some((k) => k.type === type && k.id === id),
    ekle({ type, id, name, poster, year }) {
      if (!['movie', 'series'].includes(type) || !id) return false;
      if (kayitlar.some((k) => k.type === type && k.id === id)) return true;
      kayitlar.unshift({ type, id: String(id), name: String(name || id).slice(0, 200), poster: poster || null, year: year || null, at: Date.now() });
      kayitlar = kayitlar.slice(0, EN_FAZLA);
      yaz();
      return true;
    },
    cikar(type, id) {
      const once = kayitlar.length;
      kayitlar = kayitlar.filter((k) => !(k.type === type && k.id === id));
      if (kayitlar.length !== once) yaz();
      return kayitlar.length !== once;
    },
  };
}
