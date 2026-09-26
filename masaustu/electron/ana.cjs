// Birlikte İzle masaüstü istemcisi - Electron ana süreci.
//
// Oda sayfasını olduğu gibi yükler (sohbet, kalite, altyazı, senkron hepsi çalışır) ve
// sayfadaki <video> yerine gömülü mpv'yi kullanır (bkz. video-koprusu.cjs).
//
// Not: ana süreç CommonJS olmalı - Electron 33'te ESM ana süreç 'electron' modülünü
// çözemiyor. ESM modüllerimiz dinamik import() ile alınır.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MPV = process.env.MPV_YOLU || 'C:/Program Files/MPV Player/mpv.exe';
const ODA_URL = process.env.ODA_URL || '';
const DURUM_MS = 200;

let ana = null;
let videoPenceresi = null;
let mpv = null;
let durumZamanlayici = null;
// Sayfa, mpv hazır olmadan da kaynak verebilir (odaya girer girmez oluyor);
// o adresi saklayıp mpv açılınca yüklüyoruz.
let bekleyenYukleme = null;
// Seçili altyazının geçici dosyası. loadfile her yeni dosyada altyazıyı düşürdüğü
// için 'file-loaded' olayında yeniden eklenir.
let altyaziDosyasi = null;
let altyaziSayaci = 0;
// Yazdığımız tüm geçici altyazı dosyaları. mpv dosyayı açık tuttuğu için silme,
// eski parça mpv'den çıkarıldıktan sonra yapılır; kalanlar kapanışta temizlenir.
const altyaziDosyalari = [];

function eskiAltyazilariSil() {
  while (altyaziDosyalari.length > 1) fs.rm(altyaziDosyalari.shift(), { force: true }, () => {});
}
// Sayfa stili mpv açılmadan önce yolluyor; son değeri saklayıp mpv hazır olunca uyguluyoruz.
let sonStil = null;

function altyaziStilUygula() {
  if (!mpv || !sonStil) return;
  const s = sonStil;
  // Sayfadaki ayarları mpv ölçeğine çeviriyoruz: yazı %100 = mpv'nin 55'i,
  // konum yüzdesi doğrudan sub-pos. Arka plan kutusu ancak "background-box"
  // kenar biçiminde çiziliyor; o yüzden kutu varken kenarlık seçimi devre dışı kalıyor.
  const kenar = { none: [0, 0], thin: [2, 0], thick: [4, 0], shadow: [1, 3] }[s.outline] || [2, 0];
  const alfa = Math.round(Math.max(0, Math.min(1, Number(s.bg) || 0)) * 255);
  const iki = (n) => n.toString(16).padStart(2, '0');
  const ayar = {
    'sub-font-size': Math.round(55 * (Number(s.size) || 1)),
    'sub-border-size': kenar[0],
    'sub-shadow-offset': kenar[1],
    'sub-border-style': alfa > 0 ? 'background-box' : 'outline-and-shadow',
    'sub-back-color': `#${iki(alfa)}000000`,
    'sub-pos': Math.round(Number(s.line) || 100),
  };
  for (const [ad, deger] of Object.entries(ayar)) mpv.set(ad, deger).catch((e) => console.error('altyazi-stil', ad, e.message));
}

async function altyaziEkle() {
  if (!mpv || !altyaziDosyasi) return;
  // Önceki dış altyazı silinmezse her seçimde mpv'ye bir parça daha birikiyor.
  const eskiSid = await mpv.get('sid').catch(() => null);
  // Sessiz kalmamalı: sub-add başarısız olursa altyazı hiç görünmez, sebebi belli olmaz.
  await mpv.command('sub-add', altyaziDosyasi, 'select').catch((e) => console.error('sub-add:', e.message));
  const yeniSid = await mpv.get('sid').catch(() => null);
  if (Number.isFinite(eskiSid) && eskiSid !== yeniSid) await mpv.command('sub-remove', eskiSid).catch(() => {});
  eskiAltyazilariSil();
  await mpv.set('sub-visibility', true).catch((e) => console.error('sub-visibility:', e.message));
}

const hwndOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE()) : buf.readUInt32LE();
};

function hizala(rect) {
  if (!videoPenceresi || videoPenceresi.isDestroyed() || !ana) return;
  const b = ana.getContentBounds();
  if (process.env.KABUK_DEBUG) {
    console.log('hizala | icerik', JSON.stringify(b), '| alan', JSON.stringify(rect));
  }
  videoPenceresi.setBounds({
    x: Math.round(b.x + rect.x),
    y: Math.round(b.y + rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
}

// mpv'den okunan değerleri sayfaya iter. Sayfa bunları <video> gibi görür.
async function durumDongusu() {
  if (!mpv) return;
  try {
    const [position, duration, paused, seeking, speed, width, height, cacheEnd, idle, stalled] = await Promise.all([
      mpv.get('time-pos'), mpv.get('duration'), mpv.get('pause'), mpv.get('seeking'),
      mpv.get('speed'), mpv.get('dwidth'), mpv.get('dheight'),
      mpv.get('demuxer-cache-time'), mpv.get('core-idle'), mpv.get('paused-for-cache'),
    ].map((p) => p.catch(() => null)));
    ana?.webContents.send('mpv:durum', {
      position: Number(position) || 0,
      duration: Number.isFinite(duration) ? duration : null,
      paused: Boolean(paused),
      seeking: Boolean(seeking),
      rate: Number(speed) || 1,
      width: Number(width) || 0,
      height: Number(height) || 0,
      cacheEnd: Number(cacheEnd) || 0,
      idle: Boolean(idle),
      cacheStalled: Boolean(stalled),
      loaded: Number.isFinite(duration),
    });
  } catch { /* mpv kapanmış olabilir */ }
}

async function mpvBaslat() {
  const { createMpv } = await import('../mpv.js');
  mpv = createMpv({
    binary: MPV,
    pipeName: `birlikte-izle-kabuk-${process.pid}`,
    args: [`--wid=${hwndOf(videoPenceresi)}`, '--no-config', '--keep-open=yes', '--idle=yes', '--osc=no'],
  });
  await mpv.start();
  mpv.on('exit', () => { mpv = null; });
  mpv.on('file-loaded', altyaziEkle);
  altyaziStilUygula();
  durumZamanlayici = setInterval(durumDongusu, DURUM_MS);
  if (bekleyenYukleme) {
    await mpv.load(bekleyenYukleme).catch(() => {});
    bekleyenYukleme = null;
  }
}

app.whenReady().then(() => {
  ana = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#0e0f13', title: 'Birlikte İzle',
    webPreferences: {
      preload: path.join(__dirname, 'onyukleme-kabuk.cjs'),
      // Köprü, sayfadaki <video> öğesinin özelliklerini değiştirmek zorunda. Yalıtılmış
      // bağlamda bu mümkün değil (ayrı JS dünyaları). Kum havuzu da kapalı olmalı, yoksa
      // önyükleme betiği yerel dosyaları require edemiyor ve köprü sessizce kurulmuyor.
      // Yüklenen sayfa yalnızca kendi sunucumuzun oda sayfası.
      contextIsolation: false,
      sandbox: false,
    },
  });
  ana.setMenuBarVisibility(false);

  // Saydam olmalı: Chromium boyarsa mpv'nin üstünü örter, görüntü siyah kalır.
  videoPenceresi = new BrowserWindow({
    parent: ana, frame: false, resizable: false, movable: false, skipTaskbar: true,
    transparent: true, backgroundColor: '#00000000', show: false,
  });
  videoPenceresi.setIgnoreMouseEvents(true);

  ipcMain.on('kabuk:video-alani', async (_e, rect) => {
    hizala(rect);
    if (!videoPenceresi.isVisible()) videoPenceresi.show();
    if (!mpv) await mpvBaslat();
  });
  ipcMain.on('mpv:yukle', (_e, url) => {
    if (!mpv) bekleyenYukleme = url;
    else mpv.load(url).catch(() => {});
  });
  ipcMain.on('mpv:durdur', () => mpv?.command('stop').catch(() => {}));
  ipcMain.on('mpv:sar', async (_e, saniye) => {
    await mpv?.seek(saniye).catch(() => {});
    ana?.webContents.send('mpv:sarildi');
  });
  ipcMain.on('mpv:ozellik', (_e, ad, deger) => mpv?.set(ad, deger).catch(() => {}));
  ipcMain.on('mpv:filtre', (_e, css) => {
    // CSS "brightness(1.2) contrast(0.9) saturate(1.1)" -> mpv 0-100 ölçeği
    const oku = (ad) => {
      const m = css.match(new RegExp(`${ad}\\(([\\d.]+)\\)`));
      return m ? Number(m[1]) : 1;
    };
    const olcek = (v) => Math.max(-100, Math.min(100, Math.round((v - 1) * 100)));
    mpv?.set('brightness', olcek(oku('brightness'))).catch(() => {});
    mpv?.set('contrast', olcek(oku('contrast'))).catch(() => {});
    mpv?.set('saturation', olcek(oku('saturate'))).catch(() => {});
  });

  ipcMain.on('mpv:altyazi', async (_e, metin) => {
    const yeni = path.join(os.tmpdir(), `birlikte-izle-altyazi-${process.pid}-${++altyaziSayaci}.vtt`);
    try {
      fs.writeFileSync(yeni, metin, 'utf8');
    } catch { return; }
    altyaziDosyasi = yeni;
    altyaziDosyalari.push(yeni);
    await altyaziEkle();
  });
  ipcMain.on('mpv:altyazi-kapat', () => {
    altyaziDosyasi = null;
    mpv?.set('sub-visibility', false).catch(() => {});
  });
  ipcMain.on('mpv:altyazi-gecikme', (_e, saniye) => mpv?.set('sub-delay', Number(saniye) || 0).catch(() => {}));
  ipcMain.on('mpv:altyazi-stil', (_e, s) => {
    sonStil = s;
    altyaziStilUygula();
  });

  for (const olay of ['resize', 'move']) ana.on(olay, () => ana.webContents.send('kabuk:olcum-iste'));
  ana.on('closed', () => {
    clearInterval(durumZamanlayici);
    for (const dosya of altyaziDosyalari.splice(0)) fs.rmSync(dosya, { force: true });
    mpv?.stop().catch(() => {});
    app.quit();
  });
  // Dış bağlantılar (yardım linkleri) uygulamanın içinde değil tarayıcıda açılsın.
  ana.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (ODA_URL) ana.loadURL(ODA_URL);
  else ana.loadFile(path.join(__dirname, 'baslangic.html'));
});

ipcMain.on('kabuk:odaya-git', (_e, url) => ana?.loadURL(url));
app.on('window-all-closed', () => app.quit());
