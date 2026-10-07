// Panelden seçilen motor ayarları, data/motor.json: { "motor": "torrserver" | "stremio" | null, "bekci": false, "siteden": true }.
// Motor seçimi sunucu yeniden açılınca geçerli olur; MOTOR ortam değişkeni varsa o kazanır.
// Bekçi (TorrServer çökerse kendini yeniden açsın) yeni seçenek: varsayılan kapalı.
// Siteden (film bilgisini itorrents'ten de iste, bkz. src/motor/torrent-dosyasi.js): kullanıcı gizlilik
// notunu okuyup istedi (2026-10-07), varsayılan açık; panelden kapatılabiliyor.

import fs from 'node:fs';
import path from 'node:path';

export const MOTORLAR = ['torrserver', 'stremio'];

export function createMotorSecim({ file, log }) {
  let veri = { motor: null, bekci: false, siteden: true };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    veri = { motor: MOTORLAR.includes(d.motor) ? d.motor : null, bekci: d.bekci === true, siteden: d.siteden !== false };
  } catch { /* ilk açılış */ }

  return {
    motor: () => veri.motor,
    bekci: () => veri.bekci,
    siteden: () => veri.siteden,
    yaz(yeni = {}) {
      const sonraki = { ...veri };
      if ('motor' in yeni) {
        if (!MOTORLAR.includes(yeni.motor)) return { error: 'badValue' };
        sonraki.motor = yeni.motor;
      }
      if ('bekci' in yeni) sonraki.bekci = yeni.bekci === true;
      if ('siteden' in yeni) sonraki.siteden = yeni.siteden === true;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(sonraki));
      } catch (err) {
        log?.warn?.('Motor ayarı yazılamadı', { error: err.message });
        return { error: 'yazilamadi' };
      }
      veri = sonraki;
      log?.info?.('Motor ayarı', veri);
      return { ok: true, ...veri };
    },
  };
}
