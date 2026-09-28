// Kaynak hafızası: dizide iyi indiren kaynağın yayın grubu (ör. FLUX) ve addon'u hatırlanıyor.
// Sonraki bölümlerde otomatik seçim önce bu grubun kaynaklarını ölçüyor/seçiyor.
// data/kaynak-hafiza.json: { "<diziId>": { grup, addon, kalite, at } }

import fs from 'node:fs';
import path from 'node:path';
import { grupAdi } from '../public/js/shared/kaynak-sec.js';

export function createKaynakHafiza({ file, log }) {
  let kayit = {};
  try {
    kayit = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* ilk çalıştırma */ }

  function yaz() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(kayit));
    } catch (err) {
      log.warn('Kaynak hafızası yazılamadı', { error: err.message });
    }
  }

  return {
    // contentId "tt123:2:4" -> dizi "tt123"
    oku: (contentId) => kayit[String(contentId || '').split(':')[0]] || null,
    iyi(contentId, stream) {
      const dizi = String(contentId || '').split(':')[0];
      const grup = grupAdi(stream);
      if (!dizi || !grup || !String(contentId).includes(':')) return;
      const eski = kayit[dizi];
      if (eski?.grup === grup && eski.addon === stream.addonName && Date.now() - eski.at < 3600_000) return;
      kayit[dizi] = { grup, addon: stream.addonName || null, kalite: stream.quality || null, at: Date.now() };
      yaz();
    },
  };
}
