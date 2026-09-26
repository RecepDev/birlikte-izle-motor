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

// mpv kurulum yeri kişiden kişiye değişiyor; bilinen yerlere ve PATH'e bakıyoruz.
const MPV_ADAYLARI = [
  process.env.MPV_YOLU,
  path.join(process.resourcesPath || '', 'mpv', 'mpv.exe'),
  'C:/Program Files/MPV Player/mpv.exe',
  'C:/Program Files/mpv/mpv.exe',
  'C:/Program Files (x86)/mpv/mpv.exe',
  path.join(os.homedir(), 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'mpv', 'mpv.exe'),
].filter(Boolean);

function mpvBul() {
  for (const aday of MPV_ADAYLARI) if (fs.existsSync(aday)) return aday;
  return 'mpv'; // PATH'te olabilir
}

const MPV = mpvBul();
const ODA_URL = process.env.ODA_URL || '';
const DURUM_MS = 200;

let ana = null;
let videoPenceresi = null;
let mpv = null;
let durumZamanlayici = null;
// Sayfa, mpv hazır olmadan da kaynak verebilir (odaya girer girmez oluyor);
// o adresi saklayıp mpv açılınca yüklüyoruz.
let bekleyenYukleme = null;
// Son ölçülen video alanı ve "bir diyalog açık mı": pencere geri gelince
// mpv penceresini doğru yere, yalnızca gerekiyorsa geri koyuyoruz.
let sonAlan = null;
let ortuluMu = false;
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

async function sesleriYolla() {
  if (!mpv || !ana) return;
  const liste = await mpv.get('track-list').catch(() => null);
  const sesler = (liste || [])
    .filter((t) => t.type === 'audio')
    .map((t) => ({ id: String(t.id), title: t.title || '', lang: t.lang || '', active: Boolean(t.selected) }));
  ana.webContents.send('mpv:sesler', sesler);
}

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
  if (ana.isMinimized()) return;
  const b = ana.getContentBounds();
  if (process.env.KABUK_DEBUG) {
    console.log('hizala | icerik', JSON.stringify(b), '| alan', JSON.stringify(rect));
  }
  // Video alanını pencerenin içerik alanıyla kırpıyoruz: sayfa kayarsa ya da pencere
  // küçülürse mpv penceresi uygulama penceresinin dışına taşmasın.
  const sol = Math.max(0, rect.x);
  const ust = Math.max(0, rect.y);
  const sag = Math.min(b.width, rect.x + rect.width);
  const alt = Math.min(b.height, rect.y + rect.height);
  const yeni = {
    x: Math.round(b.x + sol),
    y: Math.round(b.y + ust),
    width: Math.max(1, Math.round(sag - sol)),
    height: Math.max(1, Math.round(alt - ust)),
  };
  // Aynı sınırları tekrar yazmak pencereyi boşuna taşıyor ve oynatmayı takıltıyor.
  const simdiki = videoPenceresi.getBounds();
  if (simdiki.x === yeni.x && simdiki.y === yeni.y && simdiki.width === yeni.width && simdiki.height === yeni.height) return;
  videoPenceresi.setBounds(yeni);
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
  try {
    await mpv.start();
  } catch (err) {
    mpv = null;
    const { dialog } = require('electron');
    const secim = dialog.showMessageBoxSync(ana, {
      type: 'error',
      title: 'mpv bulunamadı',
      message: 'Video oynatıcı (mpv) başlatılamadı.',
      detail: `Aranan yer: ${MPV}\n\nmpv kurulu değilse mpv.io/installation adresinden kurabilirsin. `
        + 'Başka bir yerdeyse MPV_YOLU ortam değişkeniyle yolunu verebilirsin.\n\n'
        + err.message,
      buttons: ['mpv indirme sayfasını aç', 'Kapat'],
      defaultId: 0,
    });
    if (secim === 0) shell.openExternal('https://mpv.io/installation/');
    return;
  }
  mpv.on('exit', () => { mpv = null; });
  mpv.on('file-loaded', altyaziEkle);
  // Sayfa bu sırada hâlâ kurulmuyor olabilir (katılma ekranı), o yüzden bir de gecikmeli yolluyoruz.
  mpv.on('file-loaded', () => { sesleriYolla(); setTimeout(sesleriYolla, 1500); });
  mpv.on('track-switched', sesleriYolla);
  altyaziStilUygula();
  durumZamanlayici = setInterval(durumDongusu, DURUM_MS);
  if (bekleyenYukleme) {
    await mpv.load(bekleyenYukleme).catch(() => {});
    bekleyenYukleme = null;
  }
}

// birlikteizle://<oda adresi> bağlantısı uygulamayı açsın. Tarayıcıdaki "Masaüstü
// uygulamasında aç" düğmesi bu şemayı kullanıyor.
const SEMA = 'birlikteizle';

function semadanUrl(arglar) {
  // Sunucu uygulamayı doğrudan http adresiyle de başlatabiliyor (Stremio özel
  // şemaları kabul etmiyor), o yüzden ikisini de alıyoruz.
  const duz = (arglar || []).find((a) => typeof a === 'string' && /^https?:\/\//.test(a));
  if (duz) return duz;
  const bag = (arglar || []).find((a) => typeof a === 'string' && a.startsWith(`${SEMA}://`));
  if (!bag) return '';
  const kalan = bag.slice(`${SEMA}://`.length).replace(/\/$/, '');
  try {
    return decodeURIComponent(kalan);
  } catch {
    return kalan;
  }
}

function odayaGit(url) {
  if (!url || !ana) return;
  ana.loadURL(url);
  if (ana.isMinimized()) ana.restore();
  ana.focus();
}

// Tek örnek: ikinci kez açılınca (şema bağlantısıyla) çalışan pencere odaya gider.
const tekOrnek = app.requestSingleInstanceLock();
if (!tekOrnek) app.quit();
else {
  app.on('second-instance', (_e, arglar) => {
    if (process.env.KABUK_DEBUG) console.log('ikinci-ornek', JSON.stringify(arglar));
    odayaGit(semadanUrl(arglar));
  });
}
// Yalnızca paketlenmiş uygulama şemayı üstlensin: geliştirme sırasında çalıştırmak
// kaydı çıplak electron.exe'ye çevirip bağlantıyı bozuyor.
if (app.isPackaged) app.setAsDefaultProtocolClient(SEMA);

app.whenReady().then(() => {
  if (!tekOrnek) return; // pencere açmadan kapanıyoruz
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
    sonAlan = rect;
    hizala(rect);
    // Pencere simge durumundayken göstermeye çalışmak görev çubuğunda yanıp sönmeye
    // yol açıyor; showInactive de odağı çalmıyor.
    if (!ana.isMinimized() && !videoPenceresi.isVisible()) videoPenceresi.showInactive();
    if (!mpv) await mpvBaslat();
  });
  // Diyalog açıkken mpv penceresi gizlenir; yoksa diyaloğun üstünü örter.
  ipcMain.on('kabuk:ortu', (_e, ortulu) => {
    ortuluMu = ortulu;
    if (!videoPenceresi || videoPenceresi.isDestroyed()) return;
    if (ortulu) videoPenceresi.hide();
    else if (mpv && !ana.isMinimized()) videoPenceresi.showInactive();
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
  ipcMain.on('mpv:ses-sec', async (_e, id) => {
    await mpv?.set('aid', id).catch(() => {});
    sesleriYolla();
  });
  ipcMain.on('mpv:altyazi-gecikme', (_e, saniye) => mpv?.set('sub-delay', Number(saniye) || 0).catch(() => {}));
  ipcMain.on('mpv:altyazi-stil', (_e, s) => {
    sonStil = s;
    altyaziStilUygula();
  });

  // Sayfa tam ekrana geçtiğinde pencereyi de tam ekran yapıyoruz; yoksa görev çubuğu
  // videonun üstünde kalıyor.
  // Görev çubuğu, mpv penceresi üste alınmazsa videonun üstünde kalıyor.
  ana.webContents.on('enter-html-full-screen', () => {
    ana.setFullScreen(true);
    ana.setAlwaysOnTop(true, 'screen-saver');
    videoPenceresi?.setAlwaysOnTop(true, 'screen-saver');
  });
  ana.webContents.on('leave-html-full-screen', () => {
    ana.setFullScreen(false);
    ana.setAlwaysOnTop(false);
    videoPenceresi?.setAlwaysOnTop(false);
  });

  for (const olay of ['resize', 'move', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']) {
    // Son ölçümü bir kez de gecikmeli istiyoruz (boyut değişimi bitince düzelsin),
    // ama üst üste binen istekleri biriktirmiyoruz.
    let gecikmeli = null;
    ana.on(olay, () => {
      // Pencere taşınınca sayfadaki ölçü değişmiyor, dolayısıyla yeni ölçüm gelmiyor:
      // mpv penceresini son bilinen alanla hemen kendimiz yerine koyuyoruz.
      if (sonAlan) hizala(sonAlan);
      ana.webContents.send('kabuk:olcum-iste');
      clearTimeout(gecikmeli);
      gecikmeli = setTimeout(() => {
        if (sonAlan) hizala(sonAlan);
        ana?.webContents.send('kabuk:olcum-iste');
      }, 150);
    });
  }
  // Simge durumuna inince mpv penceresi ekranda kalmasın; geri gelince yerine dönsün.
  ana.on('minimize', () => videoPenceresi?.hide());
  ana.on('restore', () => {
    if (!mpv || ortuluMu) return;
    if (sonAlan) hizala(sonAlan);
    videoPenceresi?.showInactive();
  });

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

  const semaUrl = semadanUrl(process.argv);
  if (semaUrl) ana.loadURL(semaUrl);
  else if (ODA_URL) ana.loadURL(ODA_URL);
  else ana.loadFile(path.join(__dirname, 'baslangic.html'));
});

ipcMain.on('kabuk:odaya-git', (_e, url) => ana?.loadURL(url));
app.on('window-all-closed', () => app.quit());
