// Panelden seçilen motor ve bekçi, data/motor.json: { "motor": "torrserver" | "stremio" | null, "bekci": false }.
// Motor seçimi sunucu yeniden açılınca geçerli olur; MOTOR ortam değişkeni varsa o kazanır.
// Bekçi (TorrServer çökerse kendini yeniden açsın) yeni seçenek: varsayılan kapalı.

import fs from 'node:fs';
import path from 'node:path';

export const MOTORLAR = ['torrserver', 'stremio'];

export function createMotorSecim({ file, log }) {
  let veri = { motor: null, bekci: false };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    veri = { motor: MOTORLAR.includes(d.motor) ? d.motor : null, bekci: d.bekci === true };
  } catch { /* ilk açılış */ }

  return {
    motor: () => veri.motor,
    bekci: () => veri.bekci,
    yaz(yeni = {}) {
      const sonraki = { ...veri };
      if ('motor' in yeni) {
        if (!MOTORLAR.includes(yeni.motor)) return { error: 'badValue' };
        sonraki.motor = yeni.motor;
      }
      if ('bekci' in yeni) sonraki.bekci = yeni.bekci === true;
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
