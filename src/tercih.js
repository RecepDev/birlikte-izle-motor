// Host'un tercihleri.
// - kalite (2160p / 1080p / 720p): odada seçiliyor; "Oda aç" ekranı listede bu kaliteyi üste koyuyor ve
//   önce onun torrent'lerini denetliyor.
// - internetMbps: elle girilen internet hızı (indirme). Otomatik seçim, tam hızda bile izlenemeyecek
//   kaynakları (videonun ihtiyacı bundan fazla) hiç denemiyor (kullanıcı, 2026-10-07). null = girilmedi.
// data/tercih.json: { "kalite": "2160p", "internetMbps": 60 }

import fs from 'node:fs';
import path from 'node:path';

export const KALITELER = ['2160p', '1080p', '720p'];
const gecerliHiz = (n) => Number.isFinite(n) && n >= 1 && n <= 10_000;

export function createTercih({ file, log }) {
  let kalite = null;
  let internetMbps = null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (KALITELER.includes(d.kalite)) kalite = d.kalite;
    if (gecerliHiz(Number(d.internetMbps))) internetMbps = Number(d.internetMbps);
  } catch { /* ilk çalıştırma */ }

  function yaz() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ kalite, internetMbps }));
    } catch (err) {
      log.warn('Tercih yazılamadı', { error: err.message });
    }
  }

  return {
    kalite: () => kalite,
    internetMbps: () => internetMbps,
    ayarla(k) {
      if (!KALITELER.includes(k)) return false;
      kalite = k;
      yaz();
      return true;
    },
    // null ya da boş: silinir (girilmemiş sayılır).
    internetAyarla(mbps) {
      if (mbps === null || mbps === '' || mbps === undefined) internetMbps = null;
      else if (gecerliHiz(Number(mbps))) internetMbps = Math.round(Number(mbps) * 10) / 10;
      else return false;
      yaz();
      return true;
    },
  };
}
