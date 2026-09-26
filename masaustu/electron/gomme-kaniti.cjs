// Faz 1 risk kaniti: mpv, Electron penceresinin video alanina gomulebiliyor mu?
// Ana pencere web arayuzunu cizer; mpv, video alaninin ustune hizalanan cercevesiz bir
// alt pencerenin icine --wid ile gomulur. Bu dosya yalnizca dogrulama icindir.
const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const MPV = process.env.MPV_YOLU || 'C:/Program Files/MPV Player/mpv.exe';
const VIDEO = process.env.VIDEO_YOLU || '';

// HWND, Electron'dan kucuk-endian bir arabellek olarak gelir; mpv ondalik sayi ister.
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE()) : buf.readUInt32LE();
}

let ana = null;
let video = null;
let mpv = null;

function hizala(rect) {
  if (!video || video.isDestroyed() || !ana) return;
  const b = ana.getContentBounds();
  console.log('hizala | pencere', JSON.stringify(b), '| alan', JSON.stringify(rect));
  video.setBounds({
    x: Math.round(b.x + rect.x),
    y: Math.round(b.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
}

function baslatMpv() {
  const wid = hwndOf(video);
  console.log('mpv gomuluyor, wid =', wid);
  mpv = spawn(MPV, [
    `--wid=${wid}`, '--no-config', '--keep-open=yes', '--loop=inf',
    ...(VIDEO ? [VIDEO] : ['--idle=yes']),
  ], { stdio: 'inherit' });
  mpv.on('exit', (code) => console.log('mpv cikti:', code));
}

app.whenReady().then(() => {
  ana = new BrowserWindow({
    x: 60, y: 60, width: 1100, height: 650, backgroundColor: '#0e0f13',
    webPreferences: { preload: path.join(__dirname, 'onyukleme.cjs') },
  });
  ana.setMenuBarVisibility(false);
  ana.loadFile(path.join(__dirname, 'kanit.html'));

  // Saydam: Chromium bu pencereye hicbir sey boyamasin ki mpv'nin alt penceresi gorunsun.
  video = new BrowserWindow({
    parent: ana, frame: false, resizable: false, movable: false,
    skipTaskbar: true, transparent: true, backgroundColor: '#00000000', show: false,
  });
  video.setIgnoreMouseEvents(true);

  ipcMain.on('video-alani', (_e, rect) => {
    hizala(rect);
    if (!video.isVisible()) video.show();
    if (!mpv) baslatMpv();
  });
  for (const olay of ['resize', 'move']) ana.on(olay, () => ana.webContents.send('olcum-iste'));
  ana.on('closed', () => { mpv && mpv.kill(); app.quit(); });
});

app.on('window-all-closed', () => app.quit());
