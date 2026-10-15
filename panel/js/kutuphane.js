// Kütüphane görünümü: kişinin sağ tıkla eklediği film ve diziler (sunucuda data/kutuphane.json).
// Her afişin sağ altında kütüphane simgesi (kütüphanedeyse), sayfada Film/Dizi/Bitirilmiş/Bitirilmemiş süzgeçleri.
import { api, el, $ } from './api.js';
import { afisKart } from './afis.js';
import { filmIzlendi, diziHepsi, izlendiHazir } from './izlendi.js';

let liste = [];
let suzgec = 'hepsi';
try { suzgec = localStorage.getItem('kutuphaneSuzgec') || 'hepsi'; } catch { /* yok */ }

const SUZGEC = [
  ['hepsi', 'Tümü', () => true],
  ['movie', 'Filmler', (k) => k.type === 'movie'],
  ['series', 'Diziler', (k) => k.type === 'series'],
  ['bitti', 'Bitirilmiş', (k) => k.bitti],
  ['bitmedi', 'Bitirilmemiş', (k) => !k.bitti],
];

export const kutuphanedeMi = (type, id) => liste.some((k) => k.type === type && k.id === id);

const IKON = '<path d="M6 4.5h12a1 1 0 0 1 1 1V20l-7-4.2L5 20V5.5a1 1 0 0 1 1-1z"/>';
function ikon() {
  const kok = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${IKON}</svg>`,
    'image/svg+xml').documentElement;
  return document.importNode(kok, true);
}

// Sayfadaki bütün afişlerin sağ altına (kütüphanedeyse) simge koyar, değilse kaldırır.
const TIK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
function tikIkon() {
  const kok = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${TIK}</svg>`,
    'image/svg+xml').documentElement;
  return document.importNode(kok, true);
}
// İzlendi mi: elle işaretli (film / bütün dizi) ya da kütüphanede bitirilmiş.
export const izlendiMi = (type, id) => (type === 'movie' ? filmIzlendi(id) : diziHepsi(id)) || liste.some((k) => k.type === type && k.id === id && k.bitti);

function rozetle() {
  for (const a of document.querySelectorAll('a.afis[data-id]')) {
    const gorsel = a.querySelector('.afis-gorsel');
    if (!gorsel) continue;
    const izl = izlendiMi(a.dataset.type, a.dataset.id);
    const tik = gorsel.querySelector('.izl-rozet');
    if (izl && !tik) gorsel.append(el('span', { class: 'izl-rozet', title: 'İzlendi' }, tikIkon()));
    else if (!izl && tik) tik.remove();
    const var_ = kutuphanedeMi(a.dataset.type, a.dataset.id);
    const mevcut = gorsel.querySelector('.kut-rozet');
    if (var_ && !mevcut) gorsel.append(el('span', { class: 'kut-rozet', title: 'Kütüphanende' }, ikon()));
    else if (!var_ && mevcut) mevcut.remove();
  }
}
let bekliyor = false;
new MutationObserver(() => {
  if (bekliyor) return;
  bekliyor = true;
  requestAnimationFrame(() => { bekliyor = false; rozetle(); });
}).observe(document.body, { childList: true, subtree: true });

function suzgecCiz() {
  const kap = $('#kutuphane-suzgec');
  if (!kap) return;
  kap.replaceChildren(...SUZGEC.map(([ad, etiket, f]) => el('button', {
    type: 'button', class: `kut-chip${ad === suzgec ? ' aktif' : ''}`,
    onclick: () => { suzgec = ad; try { localStorage.setItem('kutuphaneSuzgec', ad); } catch { /* yok */ } ciz(); },
  }, `${etiket} (${liste.filter(f).length})`)));
}

function ciz() {
  const izgara = $('#kutuphane-izgara');
  if (!izgara) return;
  suzgecCiz();
  const f = SUZGEC.find((x) => x[0] === suzgec)?.[2] || (() => true);
  const gorunen = liste.filter(f);
  izgara.replaceChildren(...gorunen.map((k) => afisKart(k, {
    alt: k.type === 'series'
      ? (k.toplam ? `Dizi · ${k.izlenen}/${k.toplam} bölüm` : 'Dizi')
      : (k.year || 'Film'),
  })));
  const bos = $('#kutuphane-bos');
  bos.hidden = gorunen.length > 0;
  bos.textContent = liste.length
    ? 'Bu süzgeçle eşleşen yok.'
    : 'Kütüphanen boş. Bir afişe sağ tıklayıp "Kütüphaneye ekle"yi seç.';
  rozetle();
}

export async function yenile() {
  try { liste = await api('/api/kutuphane'); } catch { /* sunucu yoksa eski liste */ }
  ciz();
}

export async function ekle(m) {
  await api('/api/kutuphane/ekle', { method: 'POST', body: { type: m.type, id: m.id, name: m.name, poster: m.poster, year: m.year } });
  return yenile();
}

export async function cikar(type, id) {
  await api('/api/kutuphane/cikar', { method: 'POST', body: { type, id } });
  return yenile();
}

export const kutHazir = yenile();
izlendiHazir.then(rozetle);
