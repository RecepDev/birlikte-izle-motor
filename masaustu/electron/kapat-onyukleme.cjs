// Kapatma uyarısı penceresi (kapat.html): seçim ana sürece gider. Ses çıkarmaz (sistemin MessageBox'ı uyarı sesi çalıyordu).
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const sayi = Number(new URLSearchParams(location.search).get('sayi')) || 0;
  document.getElementById('baslik').textContent = `${sayi} indirme sürüyor`;
  document.getElementById('aciklama').textContent = 'Uygulamayı kapatırsan indirmeler ve sunucu durur (yarım kalanlar sonra kaldığı yerden sürer). '
    + 'Tepsiye küçültürsen arka planda devam eder; tepsideki simgeye basarak geri açabilirsin.';
  const sec = (v) => ipcRenderer.send('kapat:secim', v);
  document.getElementById('tepsi').addEventListener('click', () => sec('tepsi'));
  document.getElementById('kapat').addEventListener('click', () => sec('kapat'));
  document.getElementById('vazgec').addEventListener('click', () => sec('vazgec'));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') sec('vazgec'); });
  document.getElementById('tepsi').focus();
});
