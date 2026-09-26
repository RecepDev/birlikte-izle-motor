// Oluşturucu ile ana süreç arasındaki köprü: video alanının ölçüsünü bildirir.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kabuk', {
  videoAlani: (rect) => ipcRenderer.send('video-alani', rect),
  olcumIstendi: (fn) => ipcRenderer.on('olcum-iste', fn),
});
