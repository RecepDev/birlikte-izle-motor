// Saydam "geri" düğmesi penceresi (geri.html): tıklama ana sürece gidip odanın asıl düğmesine uygulanır.
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('geri').addEventListener('click', () => ipcRenderer.send('geri:tikla'));
  // Hover'ı ana süreç imleç konumundan bildiriyor (odak almayan pencerede :hover güvenilmez).
  ipcRenderer.on('geri:hover', (_e, ustunde) => document.getElementById('geri').classList.toggle('hover', Boolean(ustunde)));
});
