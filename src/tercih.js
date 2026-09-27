// Host'un tercih ettiği görüntü kalitesi (2160p / 1080p / 720p). Odada seçiliyor; "Oda aç"
// ekranı listede bu kaliteyi üste koyuyor ve önce onun torrent'lerini denetliyor.
// data/tercih.json: { "kalite": "2160p" }

import fs from 'node:fs';
import path from 'node:path';

export const KALITELER = ['2160p', '1080p', '720p'];

export function createTercih({ file, log }) {
  let kalite = null;
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8')).kalite;
    if (KALITELER.includes(k)) kalite = k;
  } catch { /* ilk çalıştırma */ }
  return {
    kalite: () => kalite,
    ayarla(k) {
      if (!KALITELER.includes(k)) return false;
      kalite = k;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ kalite }));
      } catch (err) {
        log.warn('Kalite tercihi yazılamadı', { error: err.message });
      }
      return true;
    },
  };
}
