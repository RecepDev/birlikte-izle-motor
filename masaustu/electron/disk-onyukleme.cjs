// Disk dolu uyarı penceresi (disk.html): seçim ana sürece gider. Pencerenin kendisi ses çıkarmaz (bip ana süreçte, bir kez).
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const sayi = Number(new URLSearchParams(location.search).get('sayi')) || 1;
  document.getElementById('baslik').textContent = 'Disk dolu: indirmeler durdu';
  document.getElementById('aciklama').textContent = `${sayi} indirme disk alanı bittiği için durdu. Yer açtıktan sonra İndirilenler'de "Hepsini sürdür"e basarsan kaldığı yerden devam eder. `
    + 'Yer açmak için önbelleği temizleyebilir ya da indirme klasörünü başka bir diske taşıyabilirsin.';
  const sec = (v) => ipcRenderer.send('disk:secim', v);
  document.getElementById('git').addEventListener('click', () => sec('git'));
  document.getElementById('tamam').addEventListener('click', () => sec('tamam'));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') sec('tamam'); });
  document.getElementById('git').focus();
});
