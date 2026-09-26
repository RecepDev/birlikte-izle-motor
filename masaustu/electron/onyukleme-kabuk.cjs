// Her sayfada çalışır. Oda sayfasındaysa video köprüsünü kurar ve video alanının
// ölçüsünü ana sürece bildirir; başlangıç sayfasındaysa yalnızca "odaya git" köprüsü verir.
const { ipcRenderer } = require('electron');

// contextIsolation kapalı: doğrudan sayfanın penceresine yazıyoruz.
window.kabuk = { odayaGit: (url) => ipcRenderer.send('kabuk:odaya-git', url) };

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
  const bildir = () => {
    const r = alan.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      ipcRenderer.send('kabuk:video-alani', { x: r.x, y: r.y, width: r.width, height: r.height });
    }
  };
  new ResizeObserver(bildir).observe(alan);
  ipcRenderer.on('kabuk:olcum-iste', bildir);
  window.addEventListener('scroll', bildir, true);
  bildir();
  return true;
}

function kur() {
  if (!document.getElementById('video')) return;
  stilEkle();
  olcumKur();
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
