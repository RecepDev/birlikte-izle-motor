// Ana uygulama kabuğu: Ana sayfa, Keşfet, İndirilenler ve Ayarlar tek sayfada. Açılışta hepsi bir kez
// yüklenir (perde altında); sonra yan çubukla geçiş anlıktır: sayfa yenilenmez, "yükleniyor" yazısı ve
// kayma olmaz. Zaten açık görünüme basmak hiçbir şey yapmaz.
import { $ } from './api.js';
import { ekraniKur } from './yan.js';
import { hazir as anaHazir } from './ana.js';
import { hazir as kesfetHazir, kesfetGit } from './kesfet.js';
import { hazir as indirilenlerHazir } from './indirilenler.js';
import { yenile as kutuphaneYenile } from './kutuphane.js';
import './sagtik.js';
import './indirme-rozet.js';
import './ayarlar.js';
import { kisayolTusuBagla } from '/js/kisayollar.js';
kisayolTusuBagla();

const ADRES = { ana: '/ana', kesfet: '/kesfet', kutuphane: '/kutuphane', indirilenler: '/indirilenler', ayarlar: '/ayarlar', sunucu: '/sunucu', eklentiler: '/eklentiler' };
const BASLIK = { ana: 'Ana sayfa', kesfet: 'Keşfet', kutuphane: 'Kütüphane', indirilenler: 'İndirilenler', ayarlar: 'Ayarlar', sunucu: 'Sunucu', eklentiler: 'Eklentiler' };
const goruntuAdi = (yol) => Object.keys(ADRES).find((k) => ADRES[k] === yol) || 'ana';

// Sunucu görünümünün kodu kabuktan bağımsız yüklenir: yavaş/hatalı olsa bile ana ekran ve perde etkilenmez.
const sunucuHazir = import('./panel.js').catch((err) => console.error('Sunucu görünümü yüklenemedi', err));

let aktif = goruntuAdi(location.pathname);
const kaydirma = {}; // görünüm -> kaydırma konumu (geri dönünce yerinde)
const kabuk = ekraniKur(aktif, (ad) => git(ad));

function goster(ad) {
  for (const b of document.querySelectorAll('.gorunum')) b.hidden = b.dataset.gorunum !== ad;
  kabuk.aktifYap(ad);
  document.title = `${BASLIK[ad]} · Birlikte İzle`;
  if (ad === 'kutuphane') kutuphaneYenile();
}

function git(ad, { gecmis = true, arama = '' } = {}) {
  if (!ADRES[ad]) return;
  // Zaten açık: bir şey yapma (arama sonuçları açıksa onlardan çık).
  if (ad === aktif && !arama) { kabuk.aramayiTemizle(); return; }
  kabuk.aramayiTemizle();
  kaydirma[aktif] = window.scrollY;
  aktif = ad;
  goster(ad);
  if (gecmis) history.pushState({ g: ad }, '', ADRES[ad] + arama);
  window.scrollTo(0, kaydirma[ad] || 0);
}

// Görünümler arası bağlantılar ("Tümü ›" gibi) sayfa yenilemeden çalışsın.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  let u;
  try { u = new URL(a.href, location.href); } catch { return; }
  if (u.origin !== location.origin || !ADRES[goruntuAdi(u.pathname)] || ADRES[goruntuAdi(u.pathname)] !== u.pathname) return;
  e.preventDefault();
  const ad = goruntuAdi(u.pathname);
  if (ad === 'kesfet' && u.searchParams.get('type')) kesfetGit(u.searchParams.get('type'), u.searchParams.get('id'));
  git(ad, { arama: ad === 'kesfet' ? u.search : '' });
  if (u.hash) document.querySelector(u.hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});

window.addEventListener('popstate', (e) => {
  const ad = e.state?.g || goruntuAdi(location.pathname);
  if (ad === aktif) return;
  kaydirma[aktif] = window.scrollY;
  aktif = ad;
  goster(ad);
  window.scrollTo(0, kaydirma[ad] || 0);
});

// Afiş boyutu: Ctrl + fare tekeri (Shift'siz) film/dizi afişlerini büyütüp küçültür, seçim hatırlanır.
// Bütün arayüzün ölçeği ayrı: Ctrl + Shift + fare tekeri (masaüstü kabuğu, onyukleme-kabuk.cjs).
let afisOlcek = 1;
try { afisOlcek = Number(localStorage.getItem('afisOlcek')) || 1; } catch { /* yok */ }
const afisUygula = () => document.documentElement.style.setProperty('--afis-olcek', String(afisOlcek));
afisUygula();
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  afisOlcek = Math.min(2, Math.max(0.6, Math.round((afisOlcek + (e.deltaY < 0 ? 0.1 : -0.1)) * 100) / 100));
  afisUygula();
  try { localStorage.setItem('afisOlcek', String(afisOlcek)); } catch { /* yok */ }
}, { passive: false });

history.replaceState({ g: aktif }, '', location.pathname + location.search);
goster(aktif);

// Perde: bütün görünümlerin ilk verisi ve ilk satırın afişleri hazır olunca kalkar (en çok 6 sn bekler).
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
async function perdeyiKaldir() {
  await Promise.race([Promise.all([anaHazir, kesfetHazir, indirilenlerHazir].map((p) => p.catch(() => {}))), bekle(6000)]);
  const resimler = [...document.querySelectorAll('.gorunum:not([hidden]) img')].slice(0, 12);
  await Promise.race([Promise.all(resimler.map((i) => (i.decode ? i.decode().catch(() => {}) : null))), bekle(1500)]);
  const perde = $('#acilis-perde');
  perde.classList.add('kalk');
  setTimeout(() => perde.remove(), 350);
}
perdeyiKaldir();
setTimeout(() => $('#acilis-perde')?.remove(), 9000); // ne olursa olsun perde sonsuza dek kalmasın
// Yedek perde betiği (perde-yedek.js) bunu görürse perdeyi kendisi kaldırır; görmezse yeniden yükler / hata gösterir.
window.__uygulamaBasladi = true;
