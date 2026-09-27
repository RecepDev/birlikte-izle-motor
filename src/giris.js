// "Girişi atla": dizinin giriş (intro) aralığını izleyenlerden öğrenir. Bölümün başında
// host 30-180 sn ileri sararsa atladığı aralık o dizi/sezon için kaydedilir; sonraki
// bölümlerde o aralığa gelince oynatıcıda "Girişi atla" düğmesi çıkar. Veri
// data/giris.json'da: { "tt123:2": { start, end, n }, "tt123": {...} } (sezon, yoksa dizi geneli).

import fs from 'node:fs';
import path from 'node:path';

const BASTAN_EN_FAZLA = 600; // giriş ilk 10 dakikada başlar
const ATLAMA_MIN = 30;
const ATLAMA_MAX = 180;

export function createGiris({ file, log }) {
  let veri = {};
  try {
    veri = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* ilk çalıştırma */ }

  function kaydet() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(veri));
    } catch (err) {
      log.warn('Giriş aralıkları kaydedilemedi', { error: err.message });
    }
  }

  // contentId "tt123:2:5" -> ["tt123:2", "tt123"]
  const anahtarlar = (contentId) => {
    const [id, sezon] = String(contentId || '').split(':');
    return sezon ? [`${id}:${sezon}`, id] : [id];
  };

  return {
    // Geçerli bir atlama mı? Öyleyse aralığı kaydeder ve true döner.
    ogren(contentId, from, to) {
      const start = Number(from);
      const end = Number(to);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      const fark = end - start;
      if (start < 0 || start > BASTAN_EN_FAZLA || fark < ATLAMA_MIN || fark > ATLAMA_MAX) return false;
      const aralik = { start: Math.round(start), end: Math.round(end) };
      for (const k of anahtarlar(contentId)) {
        const eski = veri[k];
        // Önceki kayda yakınsa ortalamasını al (tek seferlik sapmalar yumuşasın), uzaksa yenisi geçerli.
        if (eski && Math.abs(eski.start - aralik.start) < 20 && Math.abs(eski.end - aralik.end) < 20) {
          const n = Math.min(eski.n || 1, 9);
          veri[k] = {
            start: Math.round((eski.start * n + aralik.start) / (n + 1)),
            end: Math.round((eski.end * n + aralik.end) / (n + 1)),
            n: n + 1,
          };
        } else {
          veri[k] = { ...aralik, n: 1 };
        }
      }
      kaydet();
      log.info('Giriş aralığı öğrenildi', { contentId, ...aralik });
      return true;
    },
    bul(contentId) {
      for (const k of anahtarlar(contentId)) if (veri[k]) return { start: veri[k].start, end: veri[k].end };
      return null;
    },
  };
}
