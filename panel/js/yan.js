// Stremio tarzı ana ekran iskeleti: solda ikon çubuğu, üstte arama (film/dizi adı ya da oda linki).
// Arama sayfadan çıkmadan, aynı ekranda sonuç gösterir.
import { api, el } from './api.js';
import { afisKart } from './afis.js';
import { magnetAkisi } from './magnet.js';
import { menuAc, menuBaslik, menuAyrac, menuOge } from './menu.js';
import { sor } from '/js/diyalog.js';

// Çizgi ikonlar (24x24, currentColor): emoji yerine.
const IKON = {
  ana: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1V10"/>',
  kesfet: '<circle cx="12" cy="12" r="9"/><path d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/>',
  kutuphane: '<path d="M6 4.5h12a1 1 0 0 1 1 1V20l-7-4.2L5 20V5.5a1 1 0 0 1 1-1z"/>',
  indirilenler: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  eklentiler: '<path d="M10 4h4v3a2 2 0 1 0 4 0V4h2a1 1 0 0 1 1 1v4h-3a2 2 0 1 0 0 4h3v4a1 1 0 0 1-1 1h-4v-3a2 2 0 1 0-4 0v3H6a1 1 0 0 1-1-1v-4h3a2 2 0 1 0 0-4H5V5a1 1 0 0 1 1-1h4z"/>',
  sunucu: '<rect x="3.5" y="4" width="17" height="6.5" rx="1.6"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6"/><path d="M7 7.2h.01"/><path d="M7 16.8h.01"/>',
  ayarlar: '<path d="M4 7h9"/><path d="M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3"/><path d="M11 17h9"/><circle cx="9" cy="17" r="2"/>',
  ara: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  tamekran: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9"/><path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9"/><path d="M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  ok: '<path d="m6 9 6 6 6-6"/>',
  odalar: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19c.4-3.3 3-5 6-5s5.6 1.7 6 5"/><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8"/><path d="M17.5 14.4c2 .5 3.2 2 3.5 4.6"/>',
};

function svg(ic, sinif = 'ikon') {
  const kok = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ic}</svg>`,
    'image/svg+xml').documentElement;
  const dugum = document.importNode(kok, true);
  dugum.setAttribute('class', sinif);
  return dugum;
}

// Uygulama simgesi (masaustu/electron/simge.svg'nin sade hâli).
function logo() {
  const kok = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="yz" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0" stop-color="#a98bff"/><stop offset="1" stop-color="#5535e6"/></linearGradient></defs>'
    + '<rect x="8" y="8" width="240" height="240" rx="60" fill="url(#yz)"/>'
    + '<path d="M82 66 L162 114 L82 162 Z" fill="#fff" fill-opacity=".45" stroke="#fff" stroke-opacity=".45" stroke-width="14" stroke-linejoin="round"/>'
    + '<path d="M108 92 L190 142 L108 192 Z" fill="#fff" stroke="#fff" stroke-width="14" stroke-linejoin="round"/></svg>',
    'image/svg+xml').documentElement;
  const dugum = document.importNode(kok, true);
  dugum.setAttribute('class', 'yan-logo-svg');
  return dugum;
}

const SAYFALAR = [
  ['ana', 'Ana sayfa', '/ana'],
  ['kesfet', 'Keşfet', '/kesfet'],
  ['kutuphane', 'Kütüphane', '/kutuphane'],
  ['indirilenler', 'İndirilenler', '/indirilenler'],
  ['eklentiler', 'Eklentiler', '/eklentiler'],
  ['sunucu', 'Sunucu', '/sunucu'],
  ['ayarlar', 'Ayarlar', '/ayarlar'],
];

// Sağ üst: şu an açık, katılınabilecek odalar (düğme + açılır liste, 5 sn'de bir tazelenir).
function odalarKutusu() {
  const sayi = el('span', { class: 'oda-sayi', hidden: true });
  const dugme = el('button', { type: 'button', class: 'oda-dugme', title: 'Açık odalar', 'aria-label': 'Açık odalar', 'aria-expanded': 'false' }, svg(IKON.odalar), sayi);
  const liste = el('div', { class: 'oda-liste', hidden: true });
  const kap = el('div', { class: 'oda-kap' }, dugme, liste);
  let odalar = [];

  const katil = (o) => {
    if (window.kabuk?.odayaGit) window.kabuk.odayaGit(o.url);
    else location.href = o.url;
  };
  function ciz() {
    sayi.hidden = !odalar.length;
    sayi.textContent = String(odalar.length);
    dugme.classList.toggle('canli', odalar.length > 0);
    liste.replaceChildren(
      el('div', { class: 'oda-baslik', text: 'Açık odalar' }),
      ...(odalar.length
        ? odalar.map((o) => el('div', { class: 'oda-satir' },
          el('div', { class: 'oda-afis' }, o.poster ? el('img', { src: o.poster, alt: '', loading: 'lazy' }) : null),
          el('div', { class: 'oda-bilgi' },
            el('div', { class: 'oda-ad', title: o.name }, o.name),
            el('div', { class: 'oda-alt' }, o.users ? `${o.users} kişi · ${o.playing ? '▶ oynuyor' : '⏸ duraklatıldı'}` : 'Boş oda · kimse yok, katılabilirsin')),
          el('button', { type: 'button', class: 'oda-katil', onclick: () => katil(o) }, 'Katıl')))
        : [el('p', { class: 'oda-bos', text: 'Şu an açık oda yok.' })]));
  }
  async function yenile() {
    try { odalar = await api('/api/acik-odalar'); } catch { return; }
    ciz();
  }
  dugme.addEventListener('click', (e) => {
    e.stopPropagation();
    liste.hidden = !liste.hidden;
    dugme.setAttribute('aria-expanded', String(!liste.hidden));
    if (!liste.hidden) yenile();
  });
  liste.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { liste.hidden = true; dugme.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') liste.hidden = true; });
  ciz();
  yenile();
  setInterval(() => { if (!document.hidden) yenile(); }, 5000);
  return kap;
}

// Profil: adının baş harfi + ok. Basınca temalı menü: adı değiştir, Ayarlar, Sunucu, Eklentiler.
function profilDugmesi(git) {
  const ad = () => window.kabuk?.isim?.() || '';
  const harf = el('span', { class: 'profil-harf', text: (ad() || 'B').trim().charAt(0).toUpperCase() });
  const dugme = el('button', { type: 'button', class: 'ust-profil', title: 'Profil', 'aria-label': 'Profil menüsü' }, harf, svg(IKON.ok, 'ikon profil-ok'));
  dugme.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = dugme.getBoundingClientRect();
    const gec = (sayfa) => () => { if (git) git(sayfa); else location.href = `/${sayfa}`; };
    menuAc(Math.max(8, r.right - 240), r.bottom + 8, [
      menuBaslik(ad() || 'Profil'),
      ...(window.kabuk?.isimYaz ? [menuOge('Adını değiştir', async () => {
        const yeni = await sor('Adın (odada görünür):', ad());
        if (yeni?.trim()) {
          window.kabuk.isimYaz(yeni.trim().slice(0, 30));
          setTimeout(() => { harf.textContent = (ad() || 'B').trim().charAt(0).toUpperCase(); }, 80);
        }
      })] : []),
      ...(window.kabuk?.tepsiyeAl ? [menuOge('Tepsiye küçült', () => window.kabuk.tepsiyeAl())] : []),
      menuAyrac(),
      menuOge('Ayarlar', gec('ayarlar')),
      menuOge('Eklentiler', gec('eklentiler')),
      menuOge('Sunucu', gec('sunucu')),
    ]);
  });
  return dugme;
}

export function ekraniKur(aktif, git = null) {
  const dugmeler = new Map();
  const yan = el('nav', { class: 'yan' },
    ...SAYFALAR.map(([ad, baslik, adres]) => {
      const a = el('a', {
        class: `yan-dugme${ad === aktif ? ' aktif' : ''}`, href: adres, title: baslik, 'aria-label': baslik,
        // Zaten açık görünüme basınca hiçbir şey olmaz; öbürlerinde sayfa yenilenmeden görünüm değişir.
        onclick: (e) => { if (git) { e.preventDefault(); git(ad); } },
      }, svg(IKON[ad]));
      dugmeler.set(ad, a);
      return a;
    }));

  const kutu = el('input', { class: 'ust-ara', placeholder: 'Film, dizi ara ya da oda linki yapıştır', autocomplete: 'off' });
  const ustKap = el('label', { class: 'ust-ara-kap' }, svg(IKON.ara, 'ikon ara-ikon'), kutu);
  const odaKutu = odalarKutusu();
  // Stremio'daki gibi üst çubuk: solda logo, ortada arama, sağda tam ekran + açık odalar + profil.
  const logoLink = el('a', { class: 'ust-logo', href: '/ana', title: 'Birlikte İzle', onclick: (e) => { if (git) { e.preventDefault(); git('ana'); } } }, logo());
  const tamEkran = el('button', { type: 'button', class: 'ust-ikon', title: 'Tam ekran', 'aria-label': 'Tam ekran' }, svg(IKON.tamekran));
  tamEkran.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });
  const profil = profilDugmesi(git);
  document.body.prepend(el('header', { class: 'ust' },
    el('div', { class: 'ust-sol' }, logoLink), ustKap,
    el('div', { class: 'ust-sag' }, tamEkran, odaKutu, profil)));
  document.body.prepend(yan);
  document.body.classList.add('ekran');

  // Sonuçlar sayfanın içinde: ana içerik gizlenir, sonuç bölümü görünür (arama silinince geri gelir).
  const icerik = document.querySelector('main.icerik');
  const sonuc = el('section', { class: 'arama-sonuc' });
  icerik?.prepend(sonuc);
  let nesil = 0;

  const bolum = (baslik, liste) => (liste.length
    ? el('section', { class: 'satir' },
      el('div', { class: 'satir-baslik' }, el('h2', { text: baslik })),
      el('div', { class: 'afis-izgara' }, ...liste.map((m) => afisKart(m))))
    : null);

  async function ara(metin) {
    const benim = ++nesil;
    if (!metin) {
      icerik?.classList.remove('aramada');
      sonuc.replaceChildren();
      return;
    }
    icerik?.classList.add('aramada');
    // Magnet yapıştırıldıysa arama değil: dosya seçme + eşleştirme akışı.
    if (/^magnet:\?/i.test(metin)) {
      sonuc.replaceChildren();
      return magnetAkisi(sonuc, metin);
    }
    sonuc.replaceChildren(el('p', { class: 'muted', text: 'Aranıyor…' }));
    const liste = await api(`/api/search?q=${encodeURIComponent(metin)}`).catch(() => null);
    if (benim !== nesil) return;
    if (!liste) return sonuc.replaceChildren(el('p', { class: 'muted', text: 'Arama yapılamadı: internet bağlantısını denetle.' }));
    const filmler = liste.filter((s) => s.type === 'movie');
    const diziler = liste.filter((s) => s.type === 'series');
    sonuc.replaceChildren(...[bolum('Filmler', filmler), bolum('Diziler', diziler)].filter(Boolean),
      ...(liste.length ? [] : [el('p', { class: 'muted', text: `"${metin}" için sonuç yok.` })]));
  }

  let zamanlayici = null;
  kutu.addEventListener('input', () => {
    clearTimeout(zamanlayici);
    const v = kutu.value.trim();
    // Oda linki yapıştırıldıysa arama yapma: Enter'a basınca odaya girilir.
    if (/^https?:\/\/\S+\/room\/[A-Z0-9]+/i.test(v)) return;
    zamanlayici = setTimeout(() => ara(v), 350);
  });
  kutu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      kutu.value = '';
      ara('');
      return;
    }
    if (e.key !== 'Enter') return;
    const v = kutu.value.trim();
    if (!v) return;
    clearTimeout(zamanlayici);
    // Oda linki: uygulamada oynatıcı penceresinde, tarayıcıda doğrudan aç.
    if (/^https?:\/\/\S+\/room\/[A-Z0-9]+/i.test(v)) {
      if (window.kabuk?.odayaGit) window.kabuk.odayaGit(v);
      else location.href = v;
      return;
    }
    ara(v);
  });

  return {
    aktifYap(ad) { for (const [k, a] of dugmeler) a.classList.toggle('aktif', k === ad); },
    aramayiTemizle() { if (kutu.value) { kutu.value = ''; ara(''); } },
  };
}
