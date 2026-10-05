// Saydam kontrol çubuğu penceresi. mpv yerel pencerede çizdiği için oda sayfasının HTML'i
// videonun üstüne saydam binemiyor; bu pencere videonun üstünde ayrı ve saydam duruyor.
// Oda sayfasının kontrol çubuğunun aynası: sayfa çubuğun HTML'ini yolluyor (bkz.
// onyukleme-kabuk.cjs kontrolAynasi), burada çiziliyor; tıklama, kaydırma ve fare hareketi
// sayfadaki asıl öğeye iletiliyor. Böylece bütün davranış (oynat, sarma, ses, menüler) tek
// yerde, room.js'te kalıyor.
const { ipcRenderer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let kok = null;
let suruklenen = null; // fareyle tutulan kaydırıcı: değeri ayna güncellemesiyle ezilmesin

// Öğenin, çubuk köküne göre çocuk sırası yolu (ana sayfada aynı öğeyi bulmak için).
function yol(el) {
  const sira = [];
  while (el && el !== kok) {
    sira.unshift([...el.parentElement.children].indexOf(el));
    el = el.parentElement;
  }
  return el === kok ? sira : null;
}

// Gelen HTML'i mevcut DOM'a işler (yeniden kurmak sürüklemeyi ve hover'ı bozuyordu).
function esle(eski, yeni) {
  if (eski.nodeType !== yeni.nodeType || eski.nodeName !== yeni.nodeName) {
    eski.replaceWith(yeni.cloneNode(true));
    return;
  }
  if (eski.nodeType === Node.TEXT_NODE) {
    if (eski.nodeValue !== yeni.nodeValue) eski.nodeValue = yeni.nodeValue;
    return;
  }
  if (eski.nodeType !== Node.ELEMENT_NODE) return;
  for (const a of [...eski.attributes]) if (!yeni.hasAttribute(a.name)) eski.removeAttribute(a.name);
  for (const a of [...yeni.attributes]) if (eski.getAttribute(a.name) !== a.value) eski.setAttribute(a.name, a.value);
  if (eski.tagName === 'INPUT' && eski !== suruklenen && yeni.hasAttribute('value') && eski.value !== yeni.getAttribute('value')) {
    eski.value = yeni.getAttribute('value');
  }
  const ec = [...eski.childNodes];
  const yc = [...yeni.childNodes];
  for (let i = 0; i < yc.length; i++) {
    if (i < ec.length) esle(ec[i], yc[i]);
    else eski.appendChild(yc[i].cloneNode(true));
  }
  for (let i = yc.length; i < ec.length; i++) ec[i].remove();
}

ipcRenderer.on('kontrol:html', (_e, { html, origin }) => {
  const link = document.getElementById('oda-css');
  if (origin && !link.href.startsWith(origin)) link.href = `${origin}/css/room.css`;
  const sablon = document.createElement('template');
  sablon.innerHTML = html;
  const yeni = sablon.content.firstElementChild;
  if (!yeni) return;
  esle(kok, yeni);
  kok.id = 'ayna';
});

function ilet(tur, e, ek = {}) {
  const hedef = e.target.closest?.('button, input, .seek-wrap') || e.target;
  const y = yol(hedef);
  if (!y) return;
  const r = hedef.getBoundingClientRect();
  ipcRenderer.send('kontrol:olay', {
    tur, yol: y, ...ek,
    oranX: r.width ? (e.clientX - r.left) / r.width : 0.5,
    oranY: r.height ? (e.clientY - r.top) / r.height : 0.5,
  });
}

function kur() {
  document.getElementById('masaustu-css').textContent = fs.readFileSync(path.join(__dirname, 'masaustu.css'), 'utf8');
  kok = document.getElementById('ayna');
  document.addEventListener('click', (e) => {
    if (e.target.closest('input')) return; // kaydırıcılar input/change ile
    ilet('click', e);
  });
  document.addEventListener('input', (e) => ilet('input', e, { deger: e.target.value }));
  document.addEventListener('change', (e) => ilet('change', e, { deger: e.target.value }));
  document.addEventListener('pointerdown', (e) => {
    if (e.target.matches('input[type="range"]')) suruklenen = e.target;
  });
  document.addEventListener('pointerup', () => { suruklenen = null; });
  // Fare hareketi: sayfada çubuk gizlenmesin (boşta sayacı) ve çubuk ipucu gösterilsin.
  let son = 0;
  document.addEventListener('pointermove', (e) => {
    if (Date.now() - son < 50) return;
    son = Date.now();
    ilet('move', e);
  });
  document.documentElement.addEventListener('mouseleave', () => ipcRenderer.send('kontrol:olay', { tur: 'leave', yol: [] }));
  document.addEventListener('wheel', (e) => ilet('wheel', e, { deltaY: e.deltaY }), { passive: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur, { once: true });
else kur();
