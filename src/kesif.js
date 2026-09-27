// Sunucuyu bulma: tünel adresi (…trycloudflare.com) her açılışta değişiyor. Güncel adresi
// ntfy.sh'deki tahmin edilemez adlı bir konuya yazıyoruz; uygulamalar açılışta oradan okuyor.
// Konu adını uygulama ilk odaya girişte bu sunucudan öğreniyor (/kesif.json); sonrasında
// link paylaşmaya gerek kalmıyor. ntfy.sh ücretsiz ve hesapsız; mesajları 12 saat saklıyor,
// o yüzden adresi arada bir yeniden yazıyoruz. Giden tek bilgi tünel adresi.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const NTFY = 'https://ntfy.sh';
const YENILEME_MS = 2 * 60 * 60_000;

export function createKesif({ file, log, fetchImpl = fetch }) {
  let konu = null;
  try {
    konu = JSON.parse(fs.readFileSync(file, 'utf8')).konu;
  } catch { /* ilk çalıştırma */ }
  if (!konu) {
    konu = `birlikte-izle-${crypto.randomBytes(12).toString('hex')}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ konu }));
  }

  let sonAdres = null;
  let zamanlayici = null;

  async function yayinla() {
    if (!sonAdres) return;
    try {
      const yanit = await fetchImpl(`${NTFY}/${konu}`, { method: 'POST', body: sonAdres, signal: AbortSignal.timeout(10_000) });
      if (!yanit.ok) throw new Error(`HTTP ${yanit.status}`);
      log.info('Sunucu adresi duyuruldu', { adres: sonAdres });
    } catch (err) {
      log.warn('Sunucu adresi duyurulamadı', { error: err.message });
    }
  }

  return {
    konu,
    // Tünel açılınca ya da adresi değişince çağrılıyor.
    adresDegisti(adres) {
      if (!adres || adres === sonAdres) return;
      sonAdres = adres;
      yayinla();
      clearInterval(zamanlayici);
      zamanlayici = setInterval(yayinla, YENILEME_MS);
      zamanlayici.unref?.();
    },
  };
}
