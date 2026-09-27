// Her sayfada çalışır. Oda sayfasındaysa video köprüsünü kurar ve video alanının
// ölçüsünü ana sürece bildirir; başlangıç sayfasındaysa yalnızca "odaya git" köprüsü verir.
const { ipcRenderer } = require('electron');

// contextIsolation kapalı: doğrudan sayfanın penceresine yazıyoruz.
window.kabuk = {
  odayaGit: (url) => ipcRenderer.send('kabuk:odaya-git', url),
  sonSunucu: () => ipcRenderer.sendSync('kabuk:son-sunucu'),
  surum: () => ipcRenderer.sendSync('kabuk:surum'),
  sunucular: () => ipcRenderer.invoke('kabuk:sunucular'),
  guncelle: () => ipcRenderer.invoke('kabuk:guncelle'),
};

// Masaüstüne özel düzen: kontroller/bildirimler videonun dışına alınır (mpv üstlerini örter).
// Dosya olarak bağlamak yerine içeriği gömüyoruz: http sayfasından file:// yüklemesi engelleniyor.
function stilEkle() {
  const fs = require('node:fs');
  const path = require('node:path');
  const stil = document.createElement('style');
  stil.textContent = fs.readFileSync(path.join(__dirname, 'masaustu.css'), 'utf8');
  document.head.appendChild(stil);
}

// Oda sayfası mı? Video öğesi orada. mpv, <video> öğesinin kapladığı alana hizalanır.
function olcumKur() {
  const alan = document.getElementById('video');
  if (!alan) return false;
  // Ölçüm boyut değişiminde saniyede onlarca kez tetikleniyor; her seferinde IPC
  // yollamak ve pencereyi taşımak oynatmayı takıltıyordu. Kareye bir kez ve yalnızca
  // ölçü gerçekten değiştiyse yolluyoruz.
  let bekleyen = false;
  let son = '';
  const bildir = () => {
    if (bekleyen) return;
    bekleyen = true;
    requestAnimationFrame(() => {
      bekleyen = false;
      const r = alan.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Tam ekran Altyazı/Dil kutusu açıksa mpv penceresinde o kutu kadar delik açılıyor:
      // video küçülmüyor, altyazının yeri kutu kapanınca da aynı kalıyor.
      const k = document.querySelector('.player.subs-panel-open > .tab-body[data-tab="subs"]')?.getBoundingClientRect();
      const delik = k && k.width > 0 && k.height > 0 ? { x: k.x, y: k.y, width: k.width, height: k.height } : null;
      const olcu = [r.x, r.y, r.width, r.height, delik?.x, delik?.y, delik?.width, delik?.height].map((n) => Math.round(n ?? -1)).join('|');
      if (olcu === son) return;
      son = olcu;
      ipcRenderer.send('kabuk:video-alani', { x: r.x, y: r.y, width: r.width, height: r.height, delik });
    });
  };
  new ResizeObserver(bildir).observe(alan);
  const altyaziKutusu = document.querySelector('.tab-body[data-tab="subs"]');
  if (altyaziKutusu) new ResizeObserver(bildir).observe(altyaziKutusu);
  const oynatici = alan.closest('.player');
  if (oynatici) new MutationObserver(bildir).observe(oynatici, { attributes: true, attributeFilter: ['class'] });
  ipcRenderer.on('kabuk:olcum-iste', bildir);
  window.addEventListener('scroll', bildir, true);
  bildir();
  return true;
}

// mpv yerel pencerede çizdiği için HTML katmanı onun üstüne gelemiyor: bir diyalog
// ya da tam ekran kaplayan bir katman açıkken mpv penceresini gizliyoruz.
const ORTU = 'dialog[open], .overlay:not([hidden]), .compat-screen:not([hidden])';
function ortuKur() {
  const bak = () => ipcRenderer.send('kabuk:ortu', Boolean(document.querySelector(ORTU)));
  new MutationObserver(bak).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'class', 'style'],
  });
  bak();
}

function kur() {
  if (!document.getElementById('video')) return;
  stilEkle();
  olcumKur();
  ortuKur();
  try {
    require('./video-koprusu.cjs');
  } catch (err) {
    // Sessiz kalmamalı: köprü kurulmazsa sayfa tarayıcı oynatıcısını kullanmaya devam eder
    // ve mpv boş kalır - hata görünmezse bunu anlamak zor.
    console.error('Video köprüsü kurulamadı:', err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur, { once: true });
else kur();
