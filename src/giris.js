// "Girişi atla": dizinin girişinin (intro) bittiği saniye, dizi başına bir kez host'a
// soruluyor. Host bir saniye girerse o dizinin tüm bölümlerinde "Girişi atla" düğmesi
// o saniyeye atlıyor; kapatırsa bir daha sorulmuyor. Ayarlar'dan değiştirilip
// sıfırlanabiliyor (sıfırlanınca bir sonraki bölümde yeniden soruluyor).
// Veri data/giris.json'da: { "tt123": { "end": 85 } } ya da { "tt123": { "soruldu": true } }.

import fs from 'node:fs';
import path from 'node:path';

const EN_FAZLA_SN = 15 * 60;

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
      log.warn('Giriş ayarları kaydedilemedi', { error: err.message });
    }
  }

  // contentId "tt123:2:5" -> "tt123" (ayar dizinin tamamı için)
  const dizi = (contentId) => String(contentId || '').split(':')[0];

  return {
    // { end } | null ve daha önce sorulup sorulmadığı.
    durum(contentId) {
      const k = veri[dizi(contentId)];
      return { intro: Number.isFinite(k?.end) ? { end: k.end } : null, asked: Boolean(k) };
    },
    ayarla(contentId, end) {
      const sn = Math.round(Number(end));
      if (!Number.isFinite(sn) || sn < 1 || sn > EN_FAZLA_SN) return false;
      veri[dizi(contentId)] = { end: sn };
      kaydet();
      log.info('Giriş bitişi ayarlandı', { dizi: dizi(contentId), end: sn });
      return true;
    },
    // "Kapat": bu dizi için bir daha sorma.
    sorma(contentId) {
      if (!veri[dizi(contentId)]) veri[dizi(contentId)] = { soruldu: true };
      kaydet();
    },
    sifirla(contentId) {
      delete veri[dizi(contentId)];
      kaydet();
    },
  };
}
