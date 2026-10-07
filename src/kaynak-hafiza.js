// Kaynak hafızası.
// - Dizi: iyi indiren kaynağın yayın grubu (ör. FLUX) ve addon'u; sonraki bölümlerde önce bu grup ölçülüyor.
// - Gruplar (bütün filmler/diziler): her yayın grubunun iyi / kötü sayısı. Otomatik seçim iyi grupları
//   öne, kötüleri sona alıyor.
// - Kötü kaynaklar: odada açılmadığı ya da zayıf kaldığı için otomatik olarak bırakılan torrent'ler
//   (infoHash, 7 gün). Otomatik seçim bunları en sona koyuyor, bir daha önce denenmiyor.
// data/kaynak-hafiza.json: { "<diziId>": { grup, addon, kalite, at }, "_gruplar": { GRUP: { iyi, kotu, at } },
//   "_kotu": { "<infoHash>": at } }

import fs from 'node:fs';
import path from 'node:path';
import { grupAdi } from '../public/js/shared/kaynak-sec.js';

const KOTU_OMRU_MS = 7 * 24 * 3600_000;
const EN_COK_GRUP = 300;

export function createKaynakHafiza({ file, log }) {
  let kayit = {};
  try {
    kayit = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch { /* ilk çalıştırma */ }
  kayit._gruplar ||= {};
  kayit._kotu ||= {};
  const sayilan = new Set(); // aynı torrent'in "iyi"si oturum başına bir kez sayılsın

  function yaz() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(kayit));
    } catch (err) {
      log.warn('Kaynak hafızası yazılamadı', { error: err.message });
    }
  }

  function grupSay(stream, alan) {
    const grup = grupAdi(stream);
    if (!grup) return;
    const g = kayit._gruplar[grup] || { iyi: 0, kotu: 0, at: 0 };
    g[alan] += 1;
    g.at = Date.now();
    kayit._gruplar[grup] = g;
    const adlar = Object.keys(kayit._gruplar);
    if (adlar.length > EN_COK_GRUP) {
      adlar.sort((a, b) => kayit._gruplar[a].at - kayit._gruplar[b].at)
        .slice(0, adlar.length - EN_COK_GRUP)
        .forEach((a) => delete kayit._gruplar[a]);
    }
  }

  return {
    // contentId "tt123:2:4" -> dizi "tt123"
    oku: (contentId) => {
      const anahtar = String(contentId || '').split(':')[0];
      return anahtar.startsWith('_') ? null : kayit[anahtar] || null;
    },
    iyi(contentId, stream) {
      // Grup sayımı her içerik için (torrent başına bir kez).
      const ih = String(stream?.infoHash || '').toLowerCase();
      if (ih && !sayilan.has(ih)) {
        sayilan.add(ih);
        grupSay(stream, 'iyi');
        delete kayit._kotu[ih];
        yaz();
      }
      const dizi = String(contentId || '').split(':')[0];
      const grup = grupAdi(stream);
      if (!dizi || !grup || !String(contentId).includes(':')) return;
      const eski = kayit[dizi];
      if (eski?.grup === grup && eski.addon === stream.addonName && Date.now() - eski.at < 3600_000) return;
      kayit[dizi] = { grup, addon: stream.addonName || null, kalite: stream.quality || null, at: Date.now() };
      yaz();
    },
    // Odada otomatik olarak bırakılan kaynak (açılmadı / zayıftı).
    kotu(stream) {
      const ih = String(stream?.infoHash || '').toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(ih)) return;
      kayit._kotu[ih] = Date.now();
      grupSay(stream, 'kotu');
      yaz();
    },
    // Otomatik seçim için: { gruplar: { GRUP: { iyi, kotu } }, kotu: [infoHash] }
    ozet() {
      const simdi = Date.now();
      for (const [ih, at] of Object.entries(kayit._kotu)) if (simdi - at > KOTU_OMRU_MS) delete kayit._kotu[ih];
      const gruplar = Object.fromEntries(Object.entries(kayit._gruplar).map(([g, v]) => [g, { iyi: v.iyi, kotu: v.kotu }]));
      return { gruplar, kotu: Object.keys(kayit._kotu) };
    },
  };
}
