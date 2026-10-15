// Klavye / fare kısayolları: tek liste. Hem Ayarlar'daki "Kısayollar" bölümü hem "?" penceresi buradan çizer.
// Yeni kısayol eklenince burayı güncelle (kaynak: public/js/room.js keydown, panel/js/uygulama.js,
// masaustu/electron/onyukleme-kabuk.cjs).
const masaustu = Boolean(window.kabuk);

export const KISAYOLLAR = [
  {
    baslik: 'Her yerde',
    liste: [
      ['?', 'Bu kısayol listesini aç'],
      ['Ctrl + fare tekeri', 'Film/dizi afişlerini büyüt / küçült (ana sayfa, keşfet, indirilenler)'],
      ...(masaustu ? [
        ['Ctrl + Shift + fare tekeri', 'Bütün arayüzü büyüt / küçült (odada çalışmaz)'],
        ['Ctrl + +  /  Ctrl + −', 'Arayüzü büyüt / küçült'],
        ['Ctrl + 0', 'Arayüz ölçeğini sıfırla'],
        ['Alt + ←', 'Sunucu sayfalarında bir önceki sayfa'],
      ] : []),
    ],
  },
  {
    baslik: 'Odada (oynatıcı)',
    liste: [
      ['Boşluk  /  K', 'Oynat / duraklat (herkes için)'],
      ['←  /  →', '10 sn geri / ileri'],
      ['↑  /  ↓', 'Sesi artır / azalt (%5)'],
      ['M', 'Sesi kapat / aç'],
      ['P', 'Üst çubuk ve yan paneli gizle / göster (oynatıcı pencereyi kaplar)'],
      ['F  ya da video üstüne çift tık', 'Tam ekran aç / kapat (Esc ile çık)'],
      ['Videoya sağ tık', '"Diğer" menüsü: yayın linkini / magnet linkini kopyala, videoyu indir, VLC içinde aç'],
      ['S', 'Altyazı panelini aç / kapat'],
      ['C', 'Sohbeti aç / kapat'],
      ['N', 'Sonraki bölüm (yalnız host, dizilerde)'],
    ],
  },
];

// Kısayol listesini bir kapsayıcıya çizer (Ayarlar bölümü ve pencere ortak kullanır).
export function kisayolListesiCiz(kap) {
  kap.replaceChildren();
  for (const grup of KISAYOLLAR) {
    const h = document.createElement('h3');
    h.textContent = grup.baslik;
    kap.append(h);
    const tablo = document.createElement('div');
    tablo.className = 'kisayol-liste';
    for (const [tus, aciklama] of grup.liste) {
      const k = document.createElement('div');
      k.className = 'kisayol-tus';
      for (const parca of tus.split(/\s{2,}/)) {
        // "/" ve "ya da" tuş değil, bağlaç: düz yazı.
        const baglac = parca === '/' || /^ya da/.test(parca);
        const kbd = document.createElement(baglac ? 'span' : 'kbd');
        kbd.textContent = parca;
        if (baglac) kbd.className = 'muted';
        k.append(kbd);
      }
      const a = document.createElement('div');
      a.textContent = aciklama;
      tablo.append(k, a);
    }
    kap.append(tablo);
  }
}

let acik = null;
export function kisayolPenceresi() {
  if (acik?.open) return;
  const d = document.createElement('dialog');
  d.className = 'diyalog kisayol-pencere';
  const b = document.createElement('h2');
  b.textContent = 'Kısayollar';
  const kap = document.createElement('div');
  kisayolListesiCiz(kap);
  const dugmeler = document.createElement('div');
  dugmeler.className = 'diyalog-dugmeler';
  const kapat = document.createElement('button');
  kapat.type = 'button';
  kapat.className = 'diyalog-tamam';
  kapat.textContent = 'Kapat';
  kapat.addEventListener('click', () => d.close());
  dugmeler.append(kapat);
  d.append(b, kap, dugmeler);
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  kapat.focus();
  acik = d;
}

// "?" tuşu (yazı alanında değilken) listeyi açar.
export function kisayolTusuBagla() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    kisayolPenceresi();
  });
}
