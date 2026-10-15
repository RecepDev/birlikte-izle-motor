// Repliğin zor kelimelerini seçer (DOM'suz, saf: sunucu da test de kullanabiliyor).
//
// "Zor" ölçüsü: film altyazılarından çıkarılmış sıklık listesinde ilk N kelimenin
// dışında kalmak (N = kişinin seviyesi). Çekim ekleri atılarak bakılıyor: "held"
// biliniyorsa "hold" de bilinir sayılıyor.
//
// Veri biçimi (scripts/sozluk-uret.mjs üretiyor):
//   { siraSiniri: 8000, kelime: { "cunning": { r: 4821, a: [["isim","kurnazlık"]] } } }
//   r = sıklık sırası (yoksa listede yok, yani seyrek) · a = [[tür, çeviri...], ...]

import { kokAdaylari } from './kelime-kok.js';

export const EN_FAZLA_SATIR = 3;

// Filmin özel adları: altyazıda hiç küçük harfle geçmeyen büyük harfli kelimeler
// (Sollozzo, Dufresne, Zihuatanejo). Satır başındaki büyük harf cümle başı da
// olabildiği için tek repliğe bakarak ayırt edilemiyorlar; bütün dosyaya bakınca
// ayırt ediliyor. Kişi adını "zor kelime" diye göstermek kutuyu çöple dolduruyordu.
export function ozelAdlariBul(metinler) {
  const kucukGorulen = new Set();
  const buyukGorulen = new Set();
  for (const metin of metinler) {
    for (const kelime of String(metin || '').match(/[A-Za-z][A-Za-z'’-]*/g) || []) {
      const k = kelime.replace(/[’']s$/, '').toLowerCase();
      if (/^[a-z]/.test(kelime)) kucukGorulen.add(k);
      else buyukGorulen.add(k);
    }
  }
  const out = new Set();
  for (const k of buyukGorulen) if (!kucukGorulen.has(k)) out.add(k);
  return out;
}

export function createSecici(veri, seviye = 2000, { ozelAdlar = null } = {}) {
  const sozluk = veri?.kelime || {};
  const adlar = ozelAdlar instanceof Set ? ozelAdlar : new Set(ozelAdlar || []);
  let esik = Number(seviye) || 2000;

  // Kelime zaten biliniyor mu: kendisi ya da kökü ilk N kelimeden biriyse kolay.
  function kolay(kelime) {
    for (const aday of kokAdaylari(kelime)) {
      const sira = sozluk[aday]?.r;
      if (sira !== undefined && sira < esik) return true;
    }
    return false;
  }

  // Sözlükteki kaydı (çekim ekleri atılarak). Karşılığı yoksa null.
  function bak(kelime) {
    for (const aday of kokAdaylari(kelime)) {
      const kayit = sozluk[aday];
      if (kayit?.a?.length) return { kok: aday, anlamlar: kayit.a, sira: kayit.r ?? null };
    }
    return null;
  }

  return {
    kolay,
    bak,
    seviye: () => esik,
    seviyeSec(deger) { esik = Number(deger) || 2000; },
    // Repliğin zor kelimeleri: en seyrek olanlar önce.
    zorlar(metin, enFazla = EN_FAZLA_SATIR) {
      const gorulen = new Set();
      const out = [];
      for (const satir of String(metin || '').split('\n')) {
        const kelimeler = satir.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
        kelimeler.forEach((ham, i) => {
          // "Sonny's" -> "Sonny"; kısaltmalar (I'm, he'll) hiç alınmıyor.
          const kelime = ham.replace(/[’']s$/, '');
          if (/['’]/.test(kelime)) return;
          const kucuk = kelime.toLowerCase();
          if (kelime.length < 3 || gorulen.has(kucuk)) return;
          // Satır içindeki büyük harfli kelime çoğunlukla özel ad (Sollozzo, Corleone).
          if (i > 0 && /^[A-Z]/.test(kelime)) return;
          // Satır başındaki büyük harf cümle başı olabilir: filmin geneline bakan
          // özel ad listesi karar veriyor (bkz. ozelAdlariBul).
          if (adlar.has(kucuk)) return;
          gorulen.add(kucuk);
          if (kolay(kucuk)) return;
          const kayit = bak(kucuk);
          if (kayit) out.push({ kelime, ...kayit });
        });
      }
      // Sırası olmayan (listede hiç geçmeyen) kelime en seyrek sayılıyor.
      out.sort((a, b) => (b.sira ?? Infinity) - (a.sira ?? Infinity));
      return out.slice(0, enFazla);
    },
  };
}
