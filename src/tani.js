// Tanı kaydı: her cihaz oynatıcıda olanları (yükleniyor/hazır geçişleri, sarmalar, sapma, hız,
// hatalar) birkaç saniyede bir yolluyor. Hem bellekte (host oda sayfasından kişinin kaydını
// açabiliyor) hem data/tani/<oda>.log dosyasında tutuluyor: "telefon takılıyor" gibi sorunlar
// tahminle değil kayda bakılarak çözülsün. 3 günden eski dosyalar açılışta siliniyor.

import fs from 'node:fs';
import path from 'node:path';

const KISI_BASI = 600; // bellekte kişi başına en fazla kayıt
const PARTI_EN_FAZLA = 200; // tek gönderimde en fazla kayıt
const DOSYA_OMRU_MS = 3 * 24 * 3600_000;
const DOSYA_EN_FAZLA = 20 * 1024 * 1024;

export function createTani({ dir, log }) {
  const bellek = new Map(); // roomId -> Map(userId -> kayıtlar)

  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const ad of fs.readdirSync(dir)) {
      const yol = path.join(dir, ad);
      if (Date.now() - fs.statSync(yol).mtimeMs > DOSYA_OMRU_MS) fs.unlinkSync(yol);
    }
  } catch (err) {
    log.warn('Tanı klasörü hazırlanamadı', { error: err.message });
  }

  function ekle(room, user, entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const temiz = entries.slice(-PARTI_EN_FAZLA)
      .filter((e) => e && typeof e === 'object' && Number.isFinite(e.t) && typeof e.k === 'string')
      .map((e) => {
        const kayit = JSON.stringify(e);
        return kayit.length > 600 ? { t: e.t, k: String(e.k).slice(0, 30), kesildi: true } : e;
      });
    if (!temiz.length) return;
    let oda = bellek.get(room.id);
    if (!oda) bellek.set(room.id, (oda = new Map()));
    const liste = [...(oda.get(user.id) || []), ...temiz].slice(-KISI_BASI);
    oda.set(user.id, liste);

    const dosya = path.join(dir, `${room.id}.log`);
    try {
      if (fs.existsSync(dosya) && fs.statSync(dosya).size > DOSYA_EN_FAZLA) return;
      const satirlar = temiz.map((e) => {
        const { t, k, ...veri } = e;
        return `${new Date(t).toISOString()} ${user.name}#${String(user.id).slice(0, 4)} ${k} ${JSON.stringify(veri)}`;
      });
      fs.appendFileSync(dosya, `${satirlar.join('\n')}\n`);
    } catch { /* disk sorunu: bellekte yine var */ }
  }

  return {
    ekle,
    oku: (roomId, userId) => bellek.get(roomId)?.get(userId) || [],
    odaKapandi: (roomId) => bellek.delete(roomId),
  };
}
