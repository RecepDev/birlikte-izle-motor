// Zor kelime kutusu: İngilizce altyazı izlerken, ekranda duran repliğin zor
// kelimelerinin Türkçesini oynatıcının köşesinde gösterir.
//
// Niye otomatik: film izlerken kelimeye dokunup sözlüğe bakmak akışı bozuyor, hele
// birlikte izlerken (biri durdurup aratamaz). Kutu kendiliğinden yazıyor, kişi gözü
// kayarsa görüyor. Kutudaki kelimeye dokunulursa öteki anlamları da açılıyor.
//
// Seçim mantığı shared/zor-kelime-sec.js'de (saf, testli). Sözlük verisi Wiktionary'nin
// çeviri bölümlerinden üretiliyor (scripts/sozluk-uret.mjs); karşılığı olmayan kelime
// için kutu sessiz kalıyor, çünkü yanlış çeviri göstermek hiç göstermemekten kötü.

import { el, storage } from './ui.js';
import { createSecici } from './shared/zor-kelime-sec.js';

export const SEVIYELER = {
  1000: 'Başlangıç',
  2000: 'Orta',
  5000: 'İleri',
};
const VERI_YOLU = '/veri/en-tr.json';

export function createZorKelime({ playerEl, onDurum = () => {} }) {
  let secici = null;
  let veri = null;
  let ozelAdlar = null; // o filmin özel adları (altyazının bütününden)
  let yukleniyor = null;
  let hata = null;
  let acik = storage.get('zorKelime') === '1';
  let seviye = Number(storage.get('zorKelimeSeviye')) || 2000;
  let sonMetin = null;
  let acilan = null; // dokunulan kelimenin bütün anlamları açık
  let sonZorlar = [];

  const kutu = el('div', { class: 'zor-kutu', hidden: true });
  playerEl.append(kutu);

  async function yukle() {
    if (secici || yukleniyor) return yukleniyor;
    yukleniyor = (async () => {
      try {
        const res = await fetch(VERI_YOLU);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        veri = await res.json();
        secici = createSecici(veri, seviye, { ozelAdlar });
        hata = null;
      } catch (err) {
        hata = err.message || 'sözlük yüklenemedi';
        secici = null;
      } finally {
        yukleniyor = null;
        onDurum();
      }
    })();
    return yukleniyor;
  }

  function ciz(kelimeler) {
    sonZorlar = kelimeler;
    if (!acik || !kelimeler.length) {
      kutu.hidden = true;
      kutu.replaceChildren();
      return;
    }
    kutu.hidden = false;
    kutu.replaceChildren(...kelimeler.map((k) => {
      const hepsi = acilan === k.kok;
      return el('button', {
        type: 'button',
        class: `zor-satir${hepsi ? ' acik' : ''}`,
        title: hepsi ? 'Kapatmak için dokun' : 'Bütün anlamları için dokun',
        onclick: () => {
          acilan = hepsi ? null : k.kok;
          ciz(sonZorlar);
        },
      },
      el('span', { class: 'zor-kelime', text: k.kelime }),
      // Kendiliğinden görünen hâlde ilk anlamın en çok iki karşılığı yazılıyor: kutu dar
      // kalsın ve sözlüğün arka sıralardaki argo/kaba karşılıkları ekrana kendi başına
      // çıkmasın (Wiktionary "fruit" için meyve, yemiş ve bir de argo anlam veriyor).
      // Dokununca bütün anlamlar açılıyor: o zaman isteyerek bakılmış oluyor.
      ...(hepsi ? k.anlamlar : [k.anlamlar[0].slice(0, 3)]).map(([tur, ...tr]) => el('span', { class: 'zor-anlam' },
        tur ? el('span', { class: 'zor-tur', text: tur }) : null,
        el('span', { text: tr.join(', ') }))));
    }));
  }

  return {
    acikMi: () => acik,
    hazirMi: () => Boolean(secici),
    hata: () => hata,
    seviyesi: () => seviye,
    async ac(deger) {
      acik = Boolean(deger);
      storage.set('zorKelime', acik ? '1' : '0');
      if (acik) await yukle();
      else ciz([]);
      onDurum();
      if (acik) {
        const metin = sonMetin;
        sonMetin = null;
        this.goster(metin, true);
      }
    },
    // Altyazı dosyası değişince o filmin özel adları yeniden hesaplanıyor (subs.js
    // zaten bütün cue listesini ayrıştırıyor).
    ozelAdlariAyarla(adlar) {
      ozelAdlar = adlar;
      if (veri) secici = createSecici(veri, seviye, { ozelAdlar });
      sonMetin = null;
    },
    seviyeSec(deger) {
      seviye = Number(deger) || 2000;
      storage.set('zorKelimeSeviye', String(seviye));
      secici?.seviyeSec(seviye);
      acilan = null;
      const metin = sonMetin;
      sonMetin = null;
      this.goster(metin, true);
      onDurum();
    },
    // Ekranda duran repliğin metni. ingilizce: birinci altyazı İngilizce mi.
    goster(metin, ingilizce) {
      if (!acik || !ingilizce || !secici) {
        if (!kutu.hidden) ciz([]);
        return;
      }
      const temiz = String(metin || '').trim();
      if (temiz === sonMetin) return;
      sonMetin = temiz;
      acilan = null;
      ciz(temiz ? secici.zorlar(temiz) : []);
    },
  };
}
