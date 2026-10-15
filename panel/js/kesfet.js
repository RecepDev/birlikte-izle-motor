import { api, el, $ } from './api.js';
import { afisKart } from './afis.js';

const tur = $('#kesfet-tur');
const katalogSec = $('#kesfet-katalog');
const turSec = $('#kesfet-genre');
const izgara = $('#kesfet-izgara');
const durum = $('#kesfet-durum');

let katalogler = [];
let skip = 0;
let yukleniyor = false;
let bitti = false;
let nesil = 0; // seçim değişince eski isteğin cevabı karışmasın

const parametreler = new URLSearchParams(location.search);

function katalogDoldur() {
  const liste = katalogler.filter((k) => k.type === tur.value);
  katalogSec.replaceChildren(...liste.map((k) => el('option', { value: k.id }, k.name)));
  const istenen = parametreler.get('id');
  if (istenen && liste.some((k) => k.id === istenen)) katalogSec.value = istenen;
  parametreler.delete('id');
  turDoldur();
}

function turDoldur() {
  const k = katalogler.find((x) => x.type === tur.value && x.id === katalogSec.value);
  const turler = k?.genres || [];
  turSec.replaceChildren(el('option', { value: '' }, 'Tüm türler'), ...turler.map((g) => el('option', { value: g }, g)));
  turSec.hidden = !turler.length;
}

async function sayfaYukle() {
  if (yukleniyor || bitti || !katalogSec.value) return;
  yukleniyor = true;
  const benim = nesil;
  durum.textContent = 'Yükleniyor…';
  const q = new URLSearchParams({ type: tur.value, id: katalogSec.value, genre: turSec.value, skip: String(skip) });
  const metalar = await api(`/api/katalog?${q}`).catch(() => []);
  if (benim !== nesil) return;
  yukleniyor = false;
  if (!metalar.length) {
    bitti = true;
    durum.textContent = skip ? 'Hepsi bu kadar.' : 'Sonuç yok.';
    return;
  }
  skip += metalar.length;
  izgara.append(...metalar.map((m) => afisKart(m)));
  durum.textContent = '';
  // Gözcüyü yenile: liste ekrandan kısaysa sıradaki sayfa hemen istenir.
  gozcu.disconnect();
  gozcu.observe($('#kesfet-son'));
}

function sifirla() {
  nesil += 1;
  skip = 0;
  bitti = false;
  yukleniyor = false;
  izgara.replaceChildren();
  sayfaYukle();
}

// Listenin sonu görününce sıradaki sayfa (sonsuz kaydırma).
const gozcu = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) sayfaYukle(); }, { rootMargin: '600px' });

tur.addEventListener('change', () => { katalogDoldur(); sifirla(); });
katalogSec.addEventListener('change', () => { turDoldur(); sifirla(); });
turSec.addEventListener('change', sifirla);

// Ana sayfadaki "Tümü ›" bağlantısı: Keşfet'i o katalogla aç.
export function kesfetGit(t, id) {
  if (!['movie', 'series'].includes(t)) return;
  tur.value = t;
  parametreler.set('id', id || '');
  katalogDoldur();
  sifirla();
}

export const hazir = (async () => {
  katalogler = await api('/api/katalog-secenekleri').catch(() => []);
  if (!katalogler.length) {
    durum.textContent = 'Katalog alınamadı: internet bağlantısını denetle, sonra sayfayı yenile.';
    return;
  }
  if (['movie', 'series'].includes(parametreler.get('type'))) tur.value = parametreler.get('type');
  katalogDoldur();
  sifirla();
})();
