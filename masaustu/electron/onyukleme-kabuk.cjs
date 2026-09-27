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
      // Kontrol kutuları (altyazı, sohbet, bölümler…), çubuk ipucu, "Girişi atla" ve görünen
      // kontrol çubuğu için mpv penceresinde delik açılıyor: HTML videonun
      // üstünde görünüyor, video küçülmüyor.
      const oyn = alan.closest('.player');
      const secici = ['.player > .ctl-pop:not([hidden])', '.seek-tip:not([hidden])', '.skip-intro:not([hidden])', '.intro-ask:not([hidden])', '.next-ep:not([hidden])', '.notice:not([hidden]) .notice-card', '.weak-src:not([hidden])'];
      if (oyn && !oyn.classList.contains('idle')) secici.push('.player .controls');
      const delikler = secici.flatMap((q) => [...document.querySelectorAll(q)])
        .map((e) => e.getBoundingClientRect())
        .filter((k) => k.width > 0 && k.height > 0)
        .map((k) => ({ x: k.x, y: k.y, width: k.width, height: k.height }));
      const olcu = [r.x, r.y, r.width, r.height, ...delikler.flatMap((d) => [d.x, d.y, d.width, d.height])].map((n) => Math.round(n)).join('|');
      if (olcu === son) return;
      son = olcu;
      ipcRenderer.send('kabuk:video-alani', { x: r.x, y: r.y, width: r.width, height: r.height, delikler });
    });
  };
  new ResizeObserver(bildir).observe(alan);
  const kutuGozcusu = new ResizeObserver(bildir);
  for (const k of document.querySelectorAll('.ctl-pop, .seek-tip, .tab-body[data-tab="subs"], .tab-body[data-tab="chat"]')) kutuGozcusu.observe(k);
  const oynatici = alan.closest('.player');
  // Kutular açılıp kapanınca ve sekmeler oynatıcıya taşınınca.
  if (oynatici) new MutationObserver(bildir).observe(oynatici, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  ipcRenderer.on('kabuk:olcum-iste', bildir);
  window.addEventListener('scroll', bildir, true);
  document.addEventListener('fullscreenchange', bildir);
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
