// Birlikte İzle masaüstü istemcisi - Electron ana süreci.
//
// Oda sayfasını olduğu gibi yükler (sohbet, kalite, altyazı, senkron hepsi çalışır) ve
// sayfadaki <video> yerine gömülü mpv'yi kullanır (bkz. video-koprusu.cjs).
//
// Not: ana süreç CommonJS olmalı - Electron 33'te ESM ana süreç 'electron' modülünü
// çözemiyor. ESM modüllerimiz dinamik import() ile alınır.
const { app, BrowserWindow, ipcMain, shell, session, screen, Tray, Menu, dialog, Notification, nativeTheme } = require('electron');
// Koyu tema: Windows'un pencere çerçevesi/kenar çizgisi açık (beyaz) kalmasın, sistem menüleri de koyu olsun.
nativeTheme.themeSource = 'dark';
// Windows görev çubuğu simgesi: uygulamaya özgü kimlik. Kimlik verilmezse (özellikle kurulumsuz çalışmada) bütün
// electron.exe uygulamaları aynı kimliği paylaşıyor ve görev çubuğunda başka bir Electron uygulamasının (ör. canlı
// Birlikte İzle) eski simgesi/kısayolu altında toplanabiliyor. Kurulumun appId'siyle aynı: sabitlenmiş kısayol eşleşir.
if (process.platform === 'win32') app.setAppUserModelId('xyz.birlikteizle.motor.masaustu');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { vekilAdres, ayarla: vekilAyarla } = require('./stremio-vekil.cjs');
const { motoruHazirla } = require('./motor-baslat.cjs');

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
// Kaynak yüklenirken mpv siyah; o sırada sayfanın "yükleniyor" göstergesi görünsün.
let yukleniyor = false;

// mpv penceresi yalnızca her şey uygunken görünür: mpv açık, diyalog yok,
// kaynak yüklenmiş, pencere simge durumunda değil.
// Oda sayfasında mıyız? Değilsek (açılış, arama, kaynak listesi) video penceresi hiç görünmez.
let odadaMi = false;
// Diyalog açılınca mpv penceresi gizleniyor (sayfanın üstünde ayrı pencere, diyaloğu örterdi): video alanı
// siyah kalmasın diye o anki kare (altyazısıyla) alınıp sayfadaki <video>'ya kapak resmi olarak konuyor;
// diyalog kapanınca kalkıyor (onyukleme-kabuk.cjs, 'kabuk:kare').
async function kareGoster() {
  if (!mpv || !odadaMi || yukleniyor) return;
  const dosya = path.join(os.tmpdir(), `birlikte-izle-kare-${process.pid}.jpg`);
  try {
    await mpv.command('screenshot-to-file', dosya, 'subtitles');
    const veri = await fs.promises.readFile(dosya);
    if (!ortuluMu) return; // diyalog bu arada kapandı
    ana?.webContents.send('kabuk:kare', `data:image/jpeg;base64,${veri.toString('base64')}`);
  } catch { /* kare alınamazsa eskisi gibi siyah */ }
}
function videoGorunurluk() {
  if (!videoPenceresi || videoPenceresi.isDestroyed() || !ana) return;
  if (!mpv || !odadaMi || ortuluMu || yukleniyor || ana.isMinimized() || !ana.isVisible()) {
    videoPenceresi.hide();
    kontrolGorunurluk();
    return;
  }
  if (sonAlan) hizala(sonAlan);
  if (!videoPenceresi.isVisible()) videoPenceresi.showInactive();
  kontrolGorunurluk();
}
// Kontrol çubuğu penceresi: video görünürken ve çubuk açıkken (fare hareket edince), çubuğun
// sayfadaki yerinde. Video gizliyken sayfanın kendi çubuğu görünüyor, bu pencere gizli.
let kontrolPenceresi = null;
// ---- Tepsi (Windows bildirim alanı) + indirme sürerken kapatma uyarısı -----------------------------------------------
let tepsi = null;
let kapatmaOnayli = false;
let kapatmaSorulacak = false;

function tepsiyeAl() {
  if (!ana || ana.isDestroyed()) return;
  tepsiKur();
  ana.hide();
  videoGorunurluk();
}
function tepsidenAc() {
  if (!ana || ana.isDestroyed()) return;
  if (ana.isMinimized()) ana.restore();
  ana.show();
  ana.focus();
  videoGorunurluk();
}
function tamamenCik() {
  kapatmaOnayli = true;
  app.quit();
}
function tepsiKur() {
  if (tepsi) return;
  tepsi = new Tray(path.join(__dirname, 'simge.ico'));
  tepsi.setToolTip('Birlikte İzle');
  tepsi.setContextMenu(Menu.buildFromTemplate([
    { label: 'Uygulamayı aç', click: tepsidenAc },
    { type: 'separator' },
    { label: 'Tamamen çık (indirmeler ve sunucu kapanır)', click: tamamenCik },
  ]));
  tepsi.on('click', tepsidenAc);
}
// Sunucudaki indirme kayıtları; sunucuya ulaşılamazsa boş liste.
async function indirmeKayitlari() {
  try {
    const sayfa = await (await fetch(`${PANEL_URL}ana`, { signal: AbortSignal.timeout(1500) })).text();
    const anahtar = sayfa.match(/name="panel-key" content="([^"]+)"/)?.[1];
    if (!anahtar) return [];
    const d = await (await fetch(`${PANEL_URL}api/indirme`, { headers: { 'x-panel-key': anahtar }, signal: AbortSignal.timeout(1500) })).json();
    return d.kayitlar || [];
  } catch {
    return [];
  }
}
// Sunucuda sürmekte olan (iniyor/sırada) indirme sayısı; sunucuya ulaşılamazsa 0.
async function suregelenIndirme() {
  return (await indirmeKayitlari()).filter((k) => k.durum === 'iniyor' || k.durum === 'kuyrukta').length;
}

// Disk dolduğu için indirmeler durursa HER YERDEN (hangi sayfada olursa olsun, tepsideyken de) uyarı: sistem bildirimi (sesli),
// görev çubuğu yanıp söner, bip. Aynı hata için bir kez; yeni bir kayıt daha düşerse ya da 10 dk sonra hâlâ doluysa yeniden.
const diskUyarilan = new Map(); // kayıt kimliği -> uyarı zamanı
let sonDiskUyarisi = 0;
// Bildirim ayarları (Ayarlar > Bildirimler, ayar.json "bildirim"). Eski davranışlar açık, yeni olan (indirme bitti) kapalı gelir.
const BILDIRIM_VARSAYILAN = { diskBildirim: true, diskSes: true, diskPencere: true, diskSerit: true, indirmeBitti: false, indirmeBittiSes: false };
function bildirimAyari() {
  const k = ayarOku().bildirim;
  return { ...BILDIRIM_VARSAYILAN, ...(k && typeof k === 'object' ? k : {}) };
}
ipcMain.on('kabuk:bildirim', (e) => { e.returnValue = bildirimAyari(); });
ipcMain.on('kabuk:bildirim-yaz', (_e, kismi) => {
  const yeni = { ...bildirimAyari() };
  for (const ad of Object.keys(BILDIRIM_VARSAYILAN)) if (kismi && typeof kismi[ad] === 'boolean') yeni[ad] = kismi[ad];
  ayarYaz({ bildirim: yeni });
});

// İndirme bitti bildirimi (varsayılan kapalı): durumu iniyor/sırada iken "bitti"ye dönen kayıtlar için bir kez.
const onceDurum = new Map(); // kayıt kimliği -> son görülen durum
let ilkYoklama = true;
function bitenleriBildir(kayitlar) {
  const ayar = bildirimAyari();
  const bitenler = [];
  for (const k of kayitlar) {
    const once = onceDurum.get(k.id);
    if (!ilkYoklama && (once === 'iniyor' || once === 'kuyrukta') && k.durum === 'bitti') bitenler.push(k);
    onceDurum.set(k.id, k.durum);
  }
  ilkYoklama = false;
  if (!bitenler.length || !ayar.indirmeBitti) return;
  const ad = bitenler.length === 1 ? bitenler[0].ad : `${bitenler.length} indirme`;
  try {
    new Notification({ title: 'İndirme tamamlandı', body: bitenler.length === 1 ? `${ad} indirildi.` : `${ad} tamamlandı.`, silent: !ayar.indirmeBittiSes })
      .on('click', tepsidenAc).show();
  } catch { /* bildirim desteklenmiyor */ }
}

async function diskUyarisiDenetle() {
  if (!app.isReady() || !ana || ana.isDestroyed()) return;
  const kayitlar = await indirmeKayitlari();
  bitenleriBildir(kayitlar);
  const dusen = kayitlar.filter((k) => k.durum === 'hata' && /ENOSPC|no space left|yetersiz disk/i.test(String(k.hata || '')));
  if (!dusen.length) { diskUyarilan.clear(); return; }
  const simdi = Date.now();
  // Yalnız bir kez: disk dolu durumu başladığında. Aynı dönem içinde başka indirme düşse ya da zaman geçse tekrar uyarılmaz;
  // yer açılıp hata kalkınca (liste boşalınca) sıfırlanır, sonraki dolma yeniden uyarır.
  const ilkUyari = diskUyarilan.size === 0;
  for (const k of dusen) if (!diskUyarilan.has(k.id)) diskUyarilan.set(k.id, simdi);
  if (!ilkUyari) return;
  sonDiskUyarisi = simdi;
  gunluk(`disk dolu uyarısı: ${dusen.length} indirme durdu`);
  const ayar = bildirimAyari();
  if (ayar.diskBildirim) {
    try {
      new Notification({
        title: 'Disk dolu: indirmeler durdu',
        body: `${dusen.length} indirme disk alanı bittiği için durdu. Yer açıp İndirilenler'den "Hepsini sürdür"e bas.`,
        silent: !ayar.diskSes, urgency: 'critical',
      }).on('click', tepsidenAc).show();
    } catch { /* bildirim desteklenmiyorsa bip yine çalar */ }
    ana.flashFrame(true);
  }
  if (ayar.diskSes) shell.beep(); // tek bip
  if (ayar.diskPencere) diskPenceresi(dusen.length);
}

// Uygulama temalı "disk dolu" penceresi (bildirim + bip'in yanında, hangi sayfada olursan ol ekranda görünsün).
// Ana pencere tepsideyse ya da küçültülmüşse de görünür (bağımsız, her zaman üstte, görev çubuğunda yer almaz).
let diskPenceresiAcik = null;
function diskPenceresi(sayi) {
  if (diskPenceresiAcik && !diskPenceresiAcik.isDestroyed()) return;
  const w = new BrowserWindow({
    width: 500, height: 250, frame: false, resizable: false, minimizable: false, maximizable: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'disk-onyukleme.cjs'), contextIsolation: false, sandbox: false },
  });
  diskPenceresiAcik = w;
  const dinle = (e, v) => {
    if (e.sender !== w.webContents) return;
    if (v === 'git') {
      tepsidenAc();
      // Odadaysan oynatmayı bölme: yalnız pencereyi öne getir. Değilse İndirilenler'e git.
      if (!odadaMi) ana?.loadURL(`${PANEL_URL}indirilenler`).catch(() => {});
    }
    if (!w.isDestroyed()) w.destroy();
  };
  ipcMain.on('disk:secim', dinle);
  w.on('closed', () => { ipcMain.removeListener('disk:secim', dinle); diskPenceresiAcik = null; });
  w.once('ready-to-show', () => w.showInactive());
  w.loadFile(path.join(__dirname, 'disk.html'), { query: { sayi: String(sayi) } });
}
setInterval(() => { diskUyarisiDenetle().catch(() => {}); }, 5000).unref?.();
// Uygulama temalı kapatma uyarısı (Windows'un MessageBox'ı uyarı sesi çalıyordu ve temaya uymuyordu).
// 'tepsi' | 'kapat' | 'vazgec' döner; pencere kapatılırsa ya da Esc ile 'vazgec'.
function kapatmaPenceresi(sayi) {
  return new Promise((coz) => {
    const w = new BrowserWindow({
      parent: ana, modal: true, width: 500, height: 232, frame: false, resizable: false, minimizable: false, maximizable: false,
      transparent: true, backgroundColor: '#00000000', hasShadow: true, skipTaskbar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'kapat-onyukleme.cjs'), contextIsolation: false, sandbox: false },
    });
    let bitti = false;
    const bitir = (v) => {
      if (bitti) return;
      bitti = true;
      ipcMain.removeListener('kapat:secim', dinle);
      if (!w.isDestroyed()) w.destroy();
      coz(v);
    };
    const dinle = (e, v) => { if (e.sender === w.webContents) bitir(['tepsi', 'kapat'].includes(v) ? v : 'vazgec'); };
    ipcMain.on('kapat:secim', dinle);
    w.on('closed', () => bitir('vazgec'));
    w.once('ready-to-show', () => w.show());
    w.loadFile(path.join(__dirname, 'kapat.html'), { query: { sayi: String(sayi) } });
  });
}
async function kapatmaSor() {
  if (kapatmaSorulacak) return;
  kapatmaSorulacak = true;
  try {
    const sayi = await suregelenIndirme();
    if (!sayi) { kapatmaOnayli = true; ana?.close(); return; }
    const secim = await kapatmaPenceresi(sayi);
    if (secim === 'tepsi') tepsiyeAl();
    else if (secim === 'kapat') { kapatmaOnayli = true; ana?.close(); }
  } finally {
    kapatmaSorulacak = false;
  }
}
ipcMain.on('kabuk:tepsi', tepsiyeAl);

// Pencere içi tam ekranda kontroller gizliyken sağ üstteki pencere düğmelerinin simgeleri de gizlenir (sayfa bildirir).
// Düğmeler yerel olduğundan fare üstlerindeyken sayfaya olay gitmez; bu yüzden imleç o köşeye gelince biz geri açıyoruz.
let ustDugmelerGizli = false;
let ustDugmeSimgeGorunur = true;
function ustDugmeGuncelle() {
  if (!ana || ana.isDestroyed() || typeof ana.setTitleBarOverlay !== 'function') return;
  let gorunur = !ustDugmelerGizli;
  if (!gorunur) {
    const p = screen.getCursorScreenPoint();
    const b = ana.getContentBounds();
    gorunur = p.x >= b.x + b.width - 160 && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + 44;
  }
  if (gorunur === ustDugmeSimgeGorunur) return;
  ustDugmeSimgeGorunur = gorunur;
  try { ana.setTitleBarOverlay({ color: '#00000000', symbolColor: gorunur ? '#ffffff' : '#00000000', height: 40 }); } catch {}
}
ipcMain.on('kabuk:ust-dugmeler-gizli', (_e, gizli) => { ustDugmelerGizli = Boolean(gizli); ustDugmeGuncelle(); });
setInterval(() => { if (ustDugmelerGizli) ustDugmeGuncelle(); }, 120).unref?.();

// Pencere içi tam ekranın geri düğmesi: video görünürken, sayfadaki düğmenin yerinde saydam ayrı pencere.
let geriPenceresi = null;
function geriGorunurluk() {
  if (!geriPenceresi || geriPenceresi.isDestroyed() || !ana) return;
  const g = sonAlan?.geri;
  if (!g || !videoPenceresi?.isVisible()) {
    if (geriPenceresi.isVisible()) geriPenceresi.hide();
    return;
  }
  const b = ana.getContentBounds();
  const yeni = { x: Math.round(b.x + g.x), y: Math.round(b.y + g.y), width: Math.max(1, Math.round(g.width)), height: Math.max(1, Math.round(g.height)) };
  const simdiki = geriPenceresi.getBounds();
  if (simdiki.x !== yeni.x || simdiki.y !== yeni.y || simdiki.width !== yeni.width || simdiki.height !== yeni.height) geriPenceresi.setBounds(yeni);
  if (!geriPenceresi.isVisible()) geriPenceresi.showInactive();
}
// Geri düğmesi odak almayan saydam ayrı pencerede: Chromium'un :hover'ı bu pencerede bazen güncellenmiyor (fare zaten
// düğmenin üstündeyken pencere yeniden gösterilince ya da oynatma sırasında). Hover'ı imleç konumundan biz hesaplayıp yolluyoruz.
let geriUstunde = false;
setInterval(() => {
  if (!geriPenceresi || geriPenceresi.isDestroyed() || !geriPenceresi.isVisible()) { geriUstunde = false; return; }
  const p = screen.getCursorScreenPoint();
  const b = geriPenceresi.getBounds();
  const icinde = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (icinde === geriUstunde) return;
  geriUstunde = icinde;
  geriPenceresi.webContents.send('geri:hover', icinde);
}, 60).unref?.();
function kontrolGorunurluk() {
  geriGorunurluk();
  if (!kontrolPenceresi || kontrolPenceresi.isDestroyed() || !ana) return;
  const k = sonAlan?.kontrol;
  if (!k || !videoPenceresi?.isVisible()) {
    if (kontrolPenceresi.isVisible()) kontrolPenceresi.hide();
    return;
  }
  const b = ana.getContentBounds();
  const yeni = { x: Math.round(b.x + k.x), y: Math.round(b.y + k.y), width: Math.max(1, Math.round(k.width)), height: Math.max(1, Math.round(k.height)) };
  kenardanIceri(yeni, b);
  const simdiki = kontrolPenceresi.getBounds();
  if (simdiki.x !== yeni.x || simdiki.y !== yeni.y || simdiki.width !== yeni.width || simdiki.height !== yeni.height) {
    kontrolPenceresi.setBounds(yeni);
  }
  // Aynanın alt köşeleri oynatıcıyla aynı yuvarlaklıkta (aksi hâlde dikdörtgen pencere sayfanın yuvarlak köşelerini örter).
  const r = Math.max(Number(sonAlan?.yaricap) || 0, pencereAltYaricapi(b.y + b.height, yeni.y + yeni.height));
  const bicim = `${yeni.width}x${yeni.height}x${r}`;
  if (bicim !== sonKontrolBicim && !boyutDegisiyor()) {
    sonKontrolBicim = bicim;
    try {
      kontrolPenceresi.setShape(r > 0 ? altKoseleriYuvarla(yeni.width, yeni.height, r) : [{ x: 0, y: 0, width: yeni.width, height: yeni.height }]);
      gunluk(`kontrol biçimi ${bicim}`);
    } catch (err) {
      gunluk(`kontrol biçimi verilemedi: ${err.message}`);
    }
  }
  if (!kontrolPenceresi.isVisible()) kontrolPenceresi.showInactive();
}
let sonKontrolBicim = '';
function altKoseleriYuvarla(w, h, r) {
  r = Math.min(r, Math.floor(h / 2));
  const sonuc = [{ x: 0, y: 0, width: w, height: Math.max(0, h - r) }];
  for (let y = h - r; y < h; y++) {
    const dy = y + 0.5 - (h - r);
    const girinti = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (w - 2 * girinti > 0) sonuc.push({ x: girinti, y, width: w - 2 * girinti, height: 1 });
  }
  return sonuc;
}
// Seçili altyazının geçici dosyası. loadfile her yeni dosyada altyazıyı düşürdüğü
// için 'file-loaded' olayında yeniden eklenir.
let altyaziDosyasi = null;
let altyaziSayaci = 0;
// Yazdığımız tüm geçici altyazı dosyaları. mpv dosyayı açık tuttuğu için silme,
// eski parça mpv'den çıkarıldıktan sonra yapılır; kalanlar kapanışta temizlenir.
const altyaziDosyalari = [];
// İkinci altyazı (alt satır, çeviri): mpv'nin kendi "ikincil altyazı" desteğiyle
// çiziliyor. Sayfa hizalanmış dosyayı veriyor, gecikmesi ayrı (secondary-sub-delay).
let altyazi2Dosyasi = null;

function eskiAltyazilariSil() {
  while (altyaziDosyalari.length > 1) fs.rm(altyaziDosyalari.shift(), { force: true }, () => {});
}
// Sayfa stili mpv açılmadan önce yolluyor; son değeri saklayıp mpv hazır olunca uyguluyoruz.
let sonStil = null;
// İkinci altyazı açıkken asıl altyazının yukarı kaydırılacağı pay (sub-pos birimi).
const IKINCI_SATIR_BOSLUK = 6;

// Sayfanın görüntü oranı modları -> mpv. "Doldur" kırparak ekranı kaplar (panscan),
// "Uzat" oranı bozar (keepaspect kapalı), sabit oranlar görüntüyü o şekle zorlar.
let sonOran = 'fit';
const sonOzellikler = {};
function oranUygula() {
  if (!mpv) return;
  const sabit = { '16:9': '16:9', '4:3': '4:3', '21:9': '21:9' }[sonOran];
  // Yalnızca değişeni yazıyoruz: her yazım videoyu yeniden ölçeklendiriyor, üçü birden
  // yazılınca 16:9'a geçerken görüntü iki kez büyüyüp küçülüyordu.
  const yeni = { 'video-aspect-override': sabit || '-1', panscan: sonOran === 'fill' ? 1 : 0, keepaspect: sonOran !== 'stretch' };
  const komutlar = [];
  for (const [ad, deger] of Object.entries(yeni)) {
    if (oranDegerleri[ad] === deger) continue;
    oranDegerleri[ad] = deger;
    komutlar.push(`no-osd set ${ad} ${typeof deger === 'boolean' ? (deger ? 'yes' : 'no') : deger}`);
  }
  // Hepsi tek satırda: mpv aynı turda uyguluyor, ara adımda görüntü bir büyüyüp küçülmüyor.
  if (komutlar.length) mpv.raw(komutlar.join('; '));
}
// mpv yeniden açılınca sıfırlanıyor (bkz. mpvBaslat).
let oranDegerleri = { 'video-aspect-override': '-1', panscan: 0, keepaspect: true };

let sonOnbellekSn = 0;
// İzlenen torrent'in Stremio'daki gerçek indirme hızı (Mbps), 2 sn'de bir.
let torrentHizi = null;
let torrentKisi = null; // bağlı peer sayısı (bilgi kutusu)
setInterval(async () => {
  const hash = /\/([0-9a-f]{40})\//i.exec(sonYuklenen || '')?.[1];
  if (!hash) {
    torrentHizi = null;
    torrentKisi = null;
    return;
  }
  try {
    const t = await (await fetch(`http://127.0.0.1:11470/${hash}/stats.json`, { signal: AbortSignal.timeout(1500) })).json();
    torrentHizi = Number.isFinite(t?.downloadSpeed) ? Math.round((t.downloadSpeed * 8) / 1e5) / 10 : null;
    torrentKisi = Number.isFinite(t?.peers) ? t.peers : null;
  } catch {
    torrentHizi = null;
    torrentKisi = null;
  }
}, 2000).unref?.();
// Dosyanın içindeki altyazılar (dışarıdan eklediğimiz .vtt'ler hariç).
async function gomuluYolla() {
  if (!mpv || !ana) return;
  const liste = await mpv.get('track-list').catch(() => null);
  const gomulu = (liste || [])
    .filter((t) => t.type === 'sub' && !t.external)
    .map((t) => ({ id: String(t.id), title: t.title || '', lang: t.lang || '', active: Boolean(t.selected) }));
  ana.webContents.send('mpv:gomulu', gomulu);
}

// Tam ekranda sohbet: son birkaç mesaj videonun sol altında, 8 sn sonra siliniyor.
// mpv'nin osd-overlay'i ASS biçiminde yazı alıyor; ayarlar bilgisinden (alt orta)
// bağımsız konumlanıyor.
const sohbetSatirlari = [];
let sohbetZamanlayici = null;
function sohbetCiz() {
  if (!mpv) return;
  const kacis = (s) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, ' ');
  const govde = sohbetSatirlari.map((s) => `{\\b1}${kacis(s.kim)}{\\b0}: ${kacis(s.metin)}`).join('\\N');
  mpv.command({
    name: 'osd-overlay', id: 7, format: 'ass-events', res_x: 1280, res_y: 720,
    data: govde ? `{\\an1\\fs24\\bord2\\shad0\\1c&HFFFFFF&\\3c&H000000&}${govde}` : '',
  }).catch(() => {});
}
function sohbetEkle(kim, metin) {
  sohbetSatirlari.push({ kim: kim.slice(0, 24), metin: metin.slice(0, 160), zaman: Date.now() });
  while (sohbetSatirlari.length > 4) sohbetSatirlari.shift();
  sohbetCiz();
  clearInterval(sohbetZamanlayici);
  sohbetZamanlayici = setInterval(() => {
    const once = sohbetSatirlari.length;
    while (sohbetSatirlari.length && Date.now() - sohbetSatirlari[0].zaman > 8000) sohbetSatirlari.shift();
    if (sohbetSatirlari.length !== once) sohbetCiz();
    if (!sohbetSatirlari.length) clearInterval(sohbetZamanlayici);
  }, 1000);
}

// Ağ koparsa (tünel sarsıntısı, Wi-Fi değişimi) mpv dosyayı hatayla kapatıyor:
// kaldığı yerden birkaç kez yeniden deniyoruz.
let sonYuklenen = null;
let sonKonum = 0;
let yenidenDeneme = 0;
function dosyaBitti(olay) {
  if (olay.reason !== 'error' || !sonYuklenen || yenidenDeneme >= 6) return;
  yenidenDeneme++;
  const url = sonYuklenen;
  const konum = sonKonum;
  setTimeout(() => {
    if (mpv && sonYuklenen === url) mpv.command('loadfile', url, 'replace', -1, `start=${konum}`).catch(() => {});
  }, 1500 * yenidenDeneme);
}

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
    // Altyazı pencereye değil videonun kendisine göre yerleşsin: siyah boşluklar
    // pencere boyutuyla değiştiği için tam ekran/pencere arasında yeri kayıyordu.
    // Altyazı pencere içinde konumlanıyor (siyah boşluklara da inebilsin); konum
    // videoya göre hesaplanıp pencereye çevriliyor (bkz. altyaziKonumUygula).
    'sub-use-margins': true,
    'sub-ass-force-margins': true,
    // Resim altyazılar (Blu-ray PGS) video alanına kırpılıyordu: siyah boşluğa inince
    // kayboluyordu. Tüm ekrana yayılınca pencereye göre konumlanıyor (Blu-ray'deki gibi).
    'stretch-image-subs-to-screen': true,
  };
  for (const [ad, deger] of Object.entries(ayar)) mpv.set(ad, deger).catch((e) => console.error('altyazi-stil', ad, e.message));
  // Konum %2.5 adımlarla gidiyor; eski mpv sub-pos'u yalnızca tam sayı kabul ediyor.
  altyaziKonumUygula();
}

// Sayfadaki konum videoya göre (%0 videonun üstü, %100 alt kenarı, üstü alttaki siyah
// boşluk). mpv'nin sub-pos'u ise pencereye göre: videonun penceredeki yerinden çeviriyoruz.
// Böylece adımlar her pencere boyunda aynı hissettiriyor, tam ekrana geçince yer kaymıyor
// ve altyazı pencerenin altından taşıp kaybolmuyor (en fazla alt kenarda duruyor).
let sonSubPos = null;
async function altyaziKonumUygula() {
  if (!mpv || !sonStil) return;
  const satir = Number(sonStil.line);
  const konum = Number.isFinite(satir) ? satir : 100;
  const d = await mpv.get('osd-dimensions').catch(() => null);
  let pos = konum;
  if (d?.h > 0) {
    const videoBoy = d.h - (d.mt || 0) - (d.mb || 0);
    pos = (((d.mt || 0) + (konum / 100) * videoBoy) / d.h) * 100;
  }
  // sub-pos 100'de bile altyazı alt kenardan 34 birim (720p ölçeğinde) yukarıda duruyor.
  // Daha aşağısı istenirse bu boşluğu azaltıyoruz: altyazı en fazla pencerenin dibine
  // iniyor, dışarı taşıp kaybolmuyor.
  const bosluk = pos > 100 ? Math.max(0, Math.round(34 - ((pos - 100) / 100) * 720)) : 34;
  pos = Math.round(Math.max(0, Math.min(100, pos)) * 10) / 10;
  // İkinci altyazı açıkken asıl altyazı yukarı çıkıyor, çeviri onun altına (dibe) geliyor.
  // mpv ikincil altyazıyı varsayılan olarak ekranın üstüne koyuyor; istenen alt alta.
  const ikinciVar = Boolean(altyazi2Dosyasi);
  const anaPos = ikinciVar ? Math.max(0, pos - IKINCI_SATIR_BOSLUK) : pos;
  const anahtar = `${anaPos}|${bosluk}|${ikinciVar ? pos : ''}`;
  if (anahtar === sonSubPos) return;
  sonSubPos = anahtar;
  mpv?.set('sub-margin-y', bosluk).catch(() => {});
  mpv?.set('sub-pos', anaPos).catch((e) => console.error('altyazi-stil sub-pos', e.message));
  if (ikinciVar) {
    mpv?.set('secondary-sub-pos', pos).catch((e) => console.error('altyazi-stil secondary-sub-pos', e.message));
    // Çeviri satırı asıl satırdan küçük: hangisinin asıl olduğu belli olsun (sayfadaki
    // .sub-line-2 ile aynı oran).
    mpv?.set('secondary-sub-scale', Math.round((Number(sonStil?.size) || 1) * 0.78 * 100) / 100).catch(() => {});
  }
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

// İkinci altyazıyı ekler ve mpv'nin ikincil kanalına atar. Ana altyazıyla aynı
// yöntem: her seçimde eski parça çıkarılmazsa mpv'de birikiyor.
async function altyazi2Ekle() {
  if (!mpv) return;
  const eski = await mpv.get('secondary-sid').catch(() => null);
  if (!altyazi2Dosyasi) {
    if (Number.isFinite(eski)) {
      await mpv.set('secondary-sid', 'no').catch(() => {});
      await mpv.command('sub-remove', eski).catch(() => {});
    }
    altyaziKonumUygula();
    return;
  }
  // 'auto' seçtirmiyor: parçayı ekleyip ikincil kanala elle atıyoruz, birinci yerinde kalsın.
  await mpv.command('sub-add', altyazi2Dosyasi, 'auto').catch((e) => console.error('sub-add (ikinci):', e.message));
  const parcalar = await mpv.get('track-list').catch(() => null);
  const dis = (Array.isArray(parcalar) ? parcalar : [])
    .filter((t) => t.type === 'sub' && t.external)
    .map((t) => t.id);
  const yeni = dis.length ? Math.max(...dis) : null;
  if (yeni === null) return;
  await mpv.set('secondary-sid', yeni).catch((e) => console.error('secondary-sid:', e.message));
  if (Number.isFinite(eski) && eski !== yeni) await mpv.command('sub-remove', eski).catch(() => {});
  await mpv.set('secondary-sub-visibility', true).catch(() => {});
  eskiAltyazilariSil();
  altyaziKonumUygula();
}

const hwndOf = (win) => {
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? Number(buf.readBigUInt64LE()) : buf.readUInt32LE();
};

// Ayrı yerel pencereler (mpv, kontrol çubuğu) içerik alanının tam kenarına değince, ölçek yuvarlaması yüzünden bir piksel
// taşıp uygulama penceresinin ince çerçeve çizgisini örtüyordu. Normal (büyütülmemiş) pencerede kenara değen yanlar 1 px içeri alınır.
function kenardanIceri(k, b) {
  if (!ana || ana.isMaximized() || ana.isFullScreen()) return k;
  if (k.x <= b.x) { k.x += 1; k.width -= 1; }
  if (k.x + k.width >= b.x + b.width) k.width -= 1;
  if (k.y + k.height >= b.y + b.height) k.height -= 1;
  k.width = Math.max(1, k.width);
  k.height = Math.max(1, k.height);
  return k;
}
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
  kenardanIceri(yeni, b);
  // Aynı sınırları tekrar yazmak pencereyi boşuna taşıyor ve oynatmayı takıltıyor.
  const simdiki = videoPenceresi.getBounds();
  if (!(simdiki.x === yeni.x && simdiki.y === yeni.y && simdiki.width === yeni.width && simdiki.height === yeni.height)) {
    videoPenceresi.setBounds(yeni);
  }
  const delikler = (rect.delikler || (rect.delik ? [rect.delik] : []))
    .map((d) => ({ ...d, x: b.x + d.x - yeni.x, y: b.y + d.y - yeni.y }));
  if (boyutDegisiyor()) {
    // Pencere boyutu sürüklenirken her karede yüzlerce parçalı biçim hesaplamak ve uygulamak (SetWindowRgn) kasıyordu:
    // tek dikdörtgen veriyoruz, asıl biçim sürükleme durunca (gecikmeli hizala) uygulanır.
    sonBicim = 'hizli';
    try { videoPenceresi.setShape([{ x: 0, y: 0, width: yeni.width, height: yeni.height }]); } catch {}
  } else {
    delikAc(yeni, delikler, Number(rect.yaricap) || 0, pencereAltYaricapi(b.y + b.height, yeni.y + yeni.height));
  }
  kontrolGorunurluk();
}
// Pencere boyutu/konumu son 150 ms'de değiştiyse sürükleme sürüyor sayılır.
let sonBoyutOlayi = 0;
let sonHizalama = 0;
let sonOlcumIstegi = 0;
const boyutDegisiyor = () => Date.now() - sonBoyutOlayi < 150;

// HTML (kontrol kutuları, tam ekranda kontrol çubuğu) mpv'nin üstünde görünsün diye mpv
// penceresinin o kısımlarını kesiyoruz (pencere biçimi). Video küçülmüyor; altyazının
// yeri değişmiyor. Birden çok delik: pencere yatay şeritlere bölünüp her şeritte
// deliklerin dışında kalan aralıklar bırakılıyor.
let sonBicim = '';
// Uygulama penceresinin kendi köşeleri (Windows 11'de 8 px yuvarlak). Oynatıcı pencere içi tam ekranda alt kenara kadar iniyor;
// mpv'nin ve kontrol çubuğunun ayrı yerel pencereleri dikdörtgen olduğundan, alt kenara değiyorlarsa onların da alt köşeleri
// aynı yarıçapla kesilir (aksi hâlde pencerenin yuvarlak köşesinin üstünde keskin köşeler görünür). Büyütülmüş/tam ekranda köşe yok.
const PENCERE_KOSE_YARICAPI = 8;
function pencereAltYaricapi(pencereAlt, altKenar) {
  if (!ana || ana.isDestroyed() || ana.isMaximized() || ana.isFullScreen() || ana.isMinimized()) return 0;
  return Math.abs(pencereAlt - altKenar) <= 1 ? PENCERE_KOSE_YARICAPI : 0;
}
// Parçalardan oluşan biçimin alt köşelerini keser (ustKoseleriYuvarla'nın aynası).
function altKoseleriKes(parcalar, w, h, r) {
  const sonuc = [];
  for (const p of parcalar) {
    if (p.y + p.height <= h - r) { sonuc.push(p); continue; }
    const baslangic = Math.max(p.y, h - r);
    if (baslangic > p.y) sonuc.push({ x: p.x, y: p.y, width: p.width, height: baslangic - p.y });
    for (let y = baslangic; y < p.y + p.height; y++) {
      const dy = (y + 0.5) - (h - r);
      const girinti = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
      const sol = Math.max(p.x, girinti);
      const sag = Math.min(p.x + p.width, w - girinti);
      if (sag > sol) sonuc.push({ x: sol, y, width: sag - sol, height: 1 });
    }
  }
  return sonuc;
}

// Oynatıcının üst köşeleri sayfada yuvarlak (border-radius) ama mpv'nin yerel penceresi dikdörtgen, köşeler keskin
// kalıyordu. Pencere biçimi yalnız dikdörtgenlerden oluştuğu için köşe, 1 piksellik yatay şeritlerle yaklaşıklanıyor.
function ustKoseleriYuvarla(parcalar, w, r) {
  const sonuc = [];
  for (const p of parcalar) {
    if (p.y >= r) { sonuc.push(p); continue; }
    const bitis = Math.min(p.y + p.height, r);
    for (let y = p.y; y < bitis; y++) {
      const dy = r - (y + 0.5);
      const girinti = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
      const sol = Math.max(p.x, girinti);
      const sag = Math.min(p.x + p.width, w - girinti);
      if (sag > sol) sonuc.push({ x: sol, y, width: sag - sol, height: 1 });
    }
    if (p.y + p.height > r) sonuc.push({ x: p.x, y: r, width: p.width, height: p.y + p.height - r });
  }
  return sonuc;
}
function delikAc(boyut, delikler, yaricap = 0, altYaricap = 0) {
  const w = boyut.width;
  const h = boyut.height;
  const kutular = [];
  for (const d of delikler || []) {
    const sol = Math.max(0, Math.round(d.x));
    const ust = Math.max(0, Math.round(d.y));
    const sag = Math.min(w, Math.round(d.x + d.width));
    const alt = Math.min(h, Math.round(d.y + d.height));
    if (!(sag > sol && alt > ust)) continue;
    // Yuvarlak köşeli delik (sağ tık menüsü): köşe satırları 1 pikselik, içeri girintili kutulara bölünüyor.
    const r = Math.min(Number(d.r) || 0, Math.floor((sag - sol) / 2), Math.floor((alt - ust) / 2));
    if (r <= 0) { kutular.push({ sol, ust, sag, alt }); continue; }
    kutular.push({ sol, ust: ust + r, sag, alt: alt - r });
    for (let i = 0; i < r; i++) {
      const g = Math.ceil(r - Math.sqrt(Math.max(0, r * r - (r - i - 0.5) ** 2)));
      kutular.push({ sol: sol + g, ust: ust + i, sag: sag - g, alt: ust + i + 1 });
      kutular.push({ sol: sol + g, ust: alt - i - 1, sag: sag - g, alt: alt - i });
    }
  }
  const parcalar = [];
  const ysler = [...new Set([0, h, ...kutular.flatMap((k) => [k.ust, k.alt])])].sort((p, q) => p - q);
  for (let i = 0; i < ysler.length - 1; i++) {
    const y0 = ysler[i];
    const y1 = ysler[i + 1];
    const kesen = kutular.filter((k) => k.ust <= y0 && k.alt >= y1).sort((p, q) => p.sol - q.sol);
    let x = 0;
    for (const k of kesen) {
      if (k.sol > x) parcalar.push({ x, y: y0, width: k.sol - x, height: y1 - y0 });
      x = Math.max(x, k.sag);
    }
    if (x < w) parcalar.push({ x, y: y0, width: w - x, height: y1 - y0 });
  }
  let sekil = yaricap > 0 ? ustKoseleriYuvarla(parcalar, w, yaricap) : parcalar;
  if (altYaricap > 0) sekil = altKoseleriKes(sekil, w, h, altYaricap);
  const anahtar = JSON.stringify(sekil);
  if (anahtar === sonBicim) return;
  sonBicim = anahtar;
  try {
    videoPenceresi.setShape(sekil);
  } catch (e) {
    console.error('setShape:', e.message);
  }
}

// Donma bekçisi: sarmadan sonra bazen süre (ses) ilerliyor ama görüntü donuk kalıyor; mpv o
// sırada kareleri atıyor (kare kaybı saniyede onlarca). 3 sn böyle sürerse aynı yere tam sarma
// yapılıyor: çözücü sıfırlanıyor, görüntü geri geliyor. En fazla 20 sn'de bir.
let donmaSayac = 0;
let sonKayip = null;
let sonDonmaDuzeltme = 0;
function donmaBekcisi(konum, beklemede, kayip) {
  const artis = sonKayip === null ? 0 : kayip - sonKayip;
  sonKayip = kayip;
  // Durum 200 ms'de bir geliyor: 200 ms'de 3+ kare kaybı = saniyede ~15+.
  donmaSayac = !beklemede && artis >= 3 ? donmaSayac + 1 : 0;
  if (donmaSayac < 15 || Date.now() - sonDonmaDuzeltme < 20_000 || !Number.isFinite(konum)) return;
  donmaSayac = 0;
  sonDonmaDuzeltme = Date.now();
  console.warn('Görüntü donuk (kare kaybı), çözücü sıfırlanıyor', konum);
  mpv?.command('seek', String(konum), 'absolute+exact').catch(() => {});
}
// Hızlı başlat: mpv açılışta ve her sarmadan sonra 30 sn biriktirip öyle oynatıyordu (--cache-pause-wait).
// İndirme hızı videonun ihtiyacından (boyut / süre) belirgin fazlaysa o kadar beklemeye gerek yok:
// hız/ihtiyaç ≥ 2 → 5 sn, ≥ 1.5 → 10 sn, daha azı → 30 sn. Gerçek oda kaydında (2026-10-07) veri 36-61
// Mbps gelirken video 25 sn sonra başlamıştı. Açılış ekranından kapatılabiliyor (ayar "hizliBaslat").
const hizliBaslat = () => ayarOku().hizliBaslat !== false;
let tamponSn = 30;
const hizOrnekleri = []; // beklerken son 3 sn'nin indirme hızları (durum 200 ms'de bir)
function tamponAyarla(bekliyor, hiz, boyut, sure) {
  if (!mpv) return;
  let hedef = 30;
  if (!bekliyor) {
    // Oynarken bir sonraki bekleyiş yine 30'dan başlasın; hız ölçülünce iner.
    hizOrnekleri.length = 0;
  } else {
    if (Number.isFinite(hiz)) {
      hizOrnekleri.push(hiz);
      if (hizOrnekleri.length > 15) hizOrnekleri.shift();
    }
    if (hizliBaslat() && boyut > 0 && sure > 0 && hizOrnekleri.length >= 5) {
      const oran = hizOrnekleri.reduce((a, b) => a + b, 0) / hizOrnekleri.length / (boyut / sure);
      hedef = oran >= 2 ? 5 : oran >= 1.5 ? 10 : 30;
    }
  }
  if (process.env.KABUK_DEBUG && Date.now() - (tamponAyarla.son || 0) > 1000) {
    tamponAyarla.son = Date.now();
    console.log('tampon', JSON.stringify({ bekliyor, hizMbps: Math.round((hiz * 8) / 1e5) / 10, ihtiyacMbps: sure > 0 ? Math.round((boyut * 8) / sure / 1e5) / 10 : null, ornek: hizOrnekleri.length, hedef }));
  }
  if (hedef === tamponSn) return;
  tamponSn = hedef;
  mpv.set('cache-pause-wait', hedef).catch(() => {});
}
// Ara katmanın parça boyu için video süresi (bkz. stremio-vekil.cjs).
let sonVekilSure = null;
// mpv'den okunan değerleri sayfaya iter. Sayfa bunları <video> gibi görür.
async function durumDongusu() {
  if (!mpv) return;
  try {
    const [position, duration, paused, seeking, speed, width, height, cacheEnd, idle, stalled,
      cacheSec, drops, decDrops, frames, netSpeed, fileSize] = await Promise.all([
      mpv.get('time-pos'), mpv.get('duration'), mpv.get('pause'), mpv.get('seeking'),
      mpv.get('speed'), mpv.get('dwidth'), mpv.get('dheight'),
      mpv.get('demuxer-cache-time'), mpv.get('core-idle'), mpv.get('paused-for-cache'),
      mpv.get('demuxer-cache-duration'), mpv.get('frame-drop-count'), mpv.get('decoder-frame-drop-count'),
      mpv.get('estimated-frame-number'), mpv.get('cache-speed'), mpv.get('file-size'),
    ].map((p) => p.catch(() => null)));
    // Hız: mpv'nin okuma hızı açılışta parçalar sırayla gelmediği için düşük (ölçüm: 0.1 Mbps'den başladı,
    // TorrServer 50 Mbps indirirken). Torrent'te motorun gerçek indirme hızı da sayılıyor, büyüğü.
    const torrentteMi = torrentHizi !== null && /:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{40}\//i.test(sonYuklenen || '');
    const hizBps = Math.max(Number(netSpeed) || 0, torrentteMi ? (torrentHizi * 1e6) / 8 : 0);
    tamponAyarla(Boolean(stalled), hizBps, Number(fileSize), Number(duration));
    if (Number.isFinite(position) && position > 0) sonKonum = position;
    donmaBekcisi(position, paused || seeking || stalled, (Number(drops) || 0) + (Number(decDrops) || 0));
    if (Number.isFinite(duration) && duration !== sonVekilSure) {
      sonVekilSure = duration;
      vekilAyarla({ sure: duration, onbellek: onbellekSn() });
    }
    sonOnbellekSn = Number(cacheSec) || 0;
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
      // Takılmanın sebebi ağ mı çözme mi: önündeki önbellek (sn) ve atlanan kareler.
      cacheSec: Number(cacheSec) || 0,
      droppedFrames: (Number(drops) || 0) + (Number(decDrops) || 0),
      totalFrames: Number(frames) || 0,
      // mpv'nin gerçek indirme hızı (bayt/sn): sayfadaki "↓ Mbps" bundan.
      // Kendi Stremio'sundan izlerken mpv'nin okuma hızı internet değil disk hızı (zaten inmiş
      // kısmı 1000+ Mbps okuyor); o zaman Stremio'nun gerçek torrent indirme hızı.
      netMbps: torrentHizi !== null && /:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{40}\//i.test(sonYuklenen || '')
        ? torrentHizi : Number.isFinite(netSpeed) ? (netSpeed * 8) / 1e6 : null,
      // Bilgi kutusu: oynatıcının okuduğu hız (torrent'in indirdiğinden ayrı) ve bağlı kişi.
      okumaMbps: Number.isFinite(netSpeed) ? Math.round((netSpeed * 8) / 1e5) / 10 : null,
      torrentKisi,
      cacheStalled: Boolean(stalled),
      loaded: Number.isFinite(duration),
    });
  } catch { /* mpv kapanmış olabilir */ }
}

// mpv'nin diskteki geçici tamponu (4K'da birkaç GB): önbellek yeri seçildiyse onun yanında, yoksa Temp'te.
function oynaticiTamponKlasoru() {
  const secilen = ayarOku().videoOnbellekKlasor;
  if (secilen) {
    const yer = path.join(secilen, 'BirlikteIzle-oynatici');
    try {
      fs.mkdirSync(yer, { recursive: true });
      return yer;
    } catch { /* disk yoksa Temp */ }
  }
  return path.join(os.tmpdir(), 'birlikte-izle-onbellek');
}

async function mpvBaslat() {
  const { createMpv } = await import('../mpv.js');
  oranDegerleri = { 'video-aspect-override': '-1', panscan: 0, keepaspect: true };
  mpv = createMpv({
    binary: MPV,
    pipeName: `birlikte-izle-kabuk-${process.pid}`,
    args: [
      `--wid=${hwndOf(videoPenceresi)}`, '--no-config', '--keep-open=yes', '--idle=yes', '--osc=no',
      // --no-config donanım çözmeyi de kapatıyor: 4K HEVC/HDR işlemciyle çözülüp takılıyordu.
      '--hwdec=auto-safe',
      // Dosyanın kendi "varsayılan" altyazısı kendiliğinden açılmasın: altyazıyı oda seçiyor.
      '--sid=no',
      // Windows HDR açıksa HDR görüntüyü ekrana olduğu gibi ver (kapalıysa etkisi yok).
      '--target-colorspace-hint=yes',
      // Torrent akışı dalgalı: önden daha çok tamponla, kısa kesintiler görünmesin.
      // Önü ne kadar hazırlansın: Ayarlar'dan (varsayılan 3 dk). Önbellek diskte tutuluyor:
      // 4K'da 10-20 dakika birkaç GB ediyor, bellekte tutulamaz.
      '--cache=yes', '--cache-on-disk=yes', `--demuxer-cache-dir=${oynaticiTamponKlasoru()}`,
      '--demuxer-max-bytes=6GiB', `--demuxer-readahead-secs=${onbellekSn()}`,
      // Önbellek biterse saniyelik kesik kesik oynamak yerine 30 sn doldurup öyle devam et.
      // Hız yetiyorsa tamponAyarla() bunu 5-10 sn'ye indiriyor (hızlı başlat).
      '--cache-pause-wait=30',
      // Açılışta ve her sarmadan sonra da önce 30 sn hazırla, sonra oynat: sarınca hemen
      // oynayıp saniyede bir takılmasın (bu arada oda o kişiyi bekliyor).
      '--cache-pause-initial=yes',
      // Ayar bilgileri (oran, ses…) görüntünün ÜST ortasında: altta kontrol çubuğu (ayrı saydam pencere) bunları örtüyordu.
      '--osd-align-x=center', '--osd-align-y=top', '--osd-margin-y=36', '--osd-font-size=34',
    ],
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
  // Yeni mpv --cache-pause-wait=30 ile başlıyor (hızlı başlat bundan sonra ayarlar).
  tamponSn = 30;
  hizOrnekleri.length = 0;
  mpv.on('file-loaded', altyaziEkle);
  // loadfile dış altyazıları düşürüyor: ikinci satır da yeniden eklenir.
  mpv.on('file-loaded', altyazi2Ekle);
  // Pencere/oran değişince videonun yeri değişiyor: altyazı konumu yeniden hesaplanır.
  sonSubPos = null;
  mpv.observe(71, 'osd-dimensions').catch(() => {});
  mpv.on('property-change', (m) => { if (m.name === 'osd-dimensions') altyaziKonumUygula(); });
  // Sayfa bu sırada hâlâ kurulmuyor olabilir (katılma ekranı), o yüzden bir de gecikmeli yolluyoruz.
  mpv.on('file-loaded', () => {
    yenidenDeneme = 0;
    sesleriYolla();
    gomuluYolla();
    setTimeout(() => { sesleriYolla(); gomuluYolla(); }, 1500);
  });
  mpv.on('track-switched', () => { sesleriYolla(); gomuluYolla(); });
  mpv.on('end-file', dosyaBitti);
  altyaziStilUygula();
  oranUygula();
  for (const [ad, deger] of Object.entries(sonOzellikler)) mpv.set(ad, deger).catch(() => {});
  durumZamanlayici = setInterval(durumDongusu, DURUM_MS);
  if (bekleyenYukleme) {
    await mpv.load(bekleyenYukleme).catch(() => {});
    bekleyenYukleme = null;
  }
}

// ---- güncelleme ----------------------------------------------------------------------
// Odaya bağlanınca o host'un sunucusuna "daha yeni kod var mı" diye soruyoruz. Varsa
// kod dosyalarını kullanıcı klasörüne indiriyoruz; başlatıcı (baslat.cjs) bir sonraki
// açılışta onları çalıştırıyor. Electron ve mpv pakette kalıyor.
const kabuk = global.kabuk || { surum: '0.0.0', dahaYeni: () => false, guncelKlasor: path.join(app.getPath('userData'), 'guncelleme') };
const gunlukDosyasi = path.join(app.getPath('userData'), 'guncelleme.log');
// Hatalar sessiz kalmasın: neden güncellenmediği sonradan okunabilsin.
function gunluk(metin) {
  try {
    fs.appendFileSync(gunlukDosyasi, `${new Date().toISOString()} ${metin}\n`);
  } catch { /* yazılamazsa önemli değil */ }
}

let guncellemeSuruyor = false;
let sonDenetim = 0;

// kok: sunucu adresi (http://…). elle: kullanıcı "Güncellemeleri denetle"ye bastı;
// o zaman "güncelsin" / hata da bildiriliyor. Kendiliğinden denetim her oda
// açılışında (en sık 5 dakikada bir) yapılıyor; önceden oturum başına bir kezdi ve o
// an yeni sürüm yoksa uygulama kapanana kadar bir daha bakmıyordu.
async function guncellemeDenetle(kok, { elle = false } = {}) {
  const { dialog } = require('electron');
  const bildir = (tip, mesaj, detay = '') => elle && dialog.showMessageBox(ana, { type: tip, title: 'Güncelleme', message: mesaj, detail: detay });
  if (!kok?.startsWith('http')) {
    bildir('warning', 'Sunucu bulunamadı.', 'Önce bir odaya gir ya da oda linkini yapıştır.');
    return;
  }
  if (guncellemeSuruyor || (!elle && Date.now() - sonDenetim < 5 * 60_000)) return;
  guncellemeSuruyor = true;
  sonDenetim = Date.now();
  try {
    const bilgi = await (await fetch(`${kok}/indir/surum.json`, { signal: AbortSignal.timeout(8000) })).json();
    gunluk(`denetim ${kok}: sunucu ${bilgi.masaustu}, bu ${kabuk.surum}`);
    if (!bilgi.masaustu || !kabuk.dahaYeni(bilgi.masaustu, kabuk.surum)) {
      bildir('info', `Güncelsin (sürüm ${kabuk.surum}).`);
      return;
    }
    const gecici = `${kabuk.guncelKlasor}-yeni`;
    fs.rmSync(gecici, { recursive: true, force: true });
    for (const ad of bilgi.masaustuDosyalari || []) {
      const yanit = await fetch(`${kok}/indir/masaustu/${ad}`, { signal: AbortSignal.timeout(20_000) });
      if (!yanit.ok) throw new Error(`${ad}: HTTP ${yanit.status}`);
      const hedef = path.join(gecici, ...ad.split('/'));
      fs.mkdirSync(path.dirname(hedef), { recursive: true });
      fs.writeFileSync(hedef, Buffer.from(await yanit.arrayBuffer()));
    }
    fs.writeFileSync(path.join(gecici, 'surum.json'), JSON.stringify({ surum: bilgi.masaustu }));
    // Hepsi indikten sonra yer değiştir: yarım inen güncelleme hiç çalışmasın.
    fs.rmSync(kabuk.guncelKlasor, { recursive: true, force: true });
    fs.renameSync(gecici, kabuk.guncelKlasor);
    gunluk(`indirildi ${bilgi.masaustu}`);
    const secim = await dialog.showMessageBox(ana, {
      type: 'info',
      title: 'Güncelleme hazır',
      message: `Yeni sürüm indirildi (${bilgi.masaustu}).`,
      detail: 'Şimdi yeniden başlatılsın mı? Açık oda yeniden açılır.',
      buttons: ['Yeniden başlat', 'Sonra'],
      defaultId: 0,
    });
    if (secim.response === 0) {
      const adres = ana.webContents.getURL();
      app.relaunch({ args: [...process.argv.slice(1).filter((a) => !/^https?:\/\//.test(a)), ...(adres.startsWith('http') ? [adres] : [])] });
      app.exit(0);
    }
  } catch (err) {
    gunluk(`hata ${kok}: ${err.message}`);
    bildir('error', 'Güncelleme indirilemedi.', err.message);
  } finally {
    guncellemeSuruyor = false;
  }
}

// ---- sunucuyu bulma ------------------------------------------------------------------
// Son girilen odanın sunucusu ve ntfy.sh konusu (tünel adresi değişince yenisi oradan).
const ayarDosyasi = path.join(app.getPath('userData'), 'ayar.json');
function ayarOku() {
  try {
    return JSON.parse(fs.readFileSync(ayarDosyasi, 'utf8'));
  } catch {
    return {};
  }
}
function ayarYaz(ek) {
  try {
    fs.writeFileSync(ayarDosyasi, JSON.stringify({ ...ayarOku(), ...ek }));
  } catch { /* önemli değil */ }
}
async function odaSayfasiYuklendi(adres) {
  let u;
  try {
    u = new URL(adres);
  } catch {
    return;
  }
  if (!u.protocol.startsWith('http') || !u.pathname.startsWith('/room/')) return;
  ayarYaz({ sonSunucu: u.origin });
  guncellemeDenetle(u.origin);
  try {
    const { konu } = await (await fetch(`${u.origin}/kesif.json`, { signal: AbortSignal.timeout(5000) })).json();
    if (konu) ayarYaz({ konu });
  } catch { /* eski sunucu */ }
}

// ntfy.sh'deki son duyurulan adres (host'un güncel tünel adresi).
async function ntfyAdresi(konu) {
  if (!konu) return null;
  try {
    const metin = await (await fetch(`https://ntfy.sh/${konu}/json?poll=1&since=12h`, { signal: AbortSignal.timeout(5000) })).text();
    const mesajlar = metin.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)).filter((m) => m.event === 'message');
    const son = mesajlar.at(-1)?.message?.trim();
    return /^https?:\/\//.test(son || '') ? son : null;
  } catch {
    return null;
  }
}

// Açılış ekranı için bilinen sunucular: sende çalışan, ntfy'deki güncel, son girilen.
// ntfy'ye 5 sn'de bir sormamak için bulunan adres bir dakika saklanıyor.
let ntfyOnbellek = { adres: null, zaman: 0 };
// Konu adı pakete gömülü (host'un sunucusundan): uygulama hiç odaya girmemiş olsa da bulur.
function gomuluKonu() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kesif.json'), 'utf8')).konu || null;
  } catch {
    return null;
  }
}
async function sunucular() {
  const ayar = { konu: gomuluKonu(), ...ayarOku() };
  if (Date.now() - ntfyOnbellek.zaman > 60_000) ntfyOnbellek = { adres: await ntfyAdresi(ayar.konu), zaman: Date.now() };
  const guncel = ntfyOnbellek.adres;
  if (guncel && guncel !== ayar.sonSunucu) ayarYaz({ sonSunucu: guncel });
  return [...new Set(['http://127.0.0.1:7300', guncel, ayar.sonSunucu].filter(Boolean))];
}
ipcMain.handle('kabuk:sunucular', () => sunucular());
ipcMain.on('kabuk:son-sunucu', (e) => { e.returnValue = ayarOku().sonSunucu || null; });
ipcMain.on('kabuk:surum', (e) => { e.returnValue = kabuk.surum; });
// Önü hazırlama süresi (sn): odadaki Ayarlar'dan. Çalışan mpv'ye de hemen uygulanıyor.
const onbellekSn = () => [60, 180, 300, 600, 1200].includes(ayarOku().onbellekSn) ? ayarOku().onbellekSn : 180;
ipcMain.on('kabuk:onbellek', (e) => { e.returnValue = onbellekSn(); });
ipcMain.on('kabuk:onbellek-yaz', (_e, sn) => {
  if (![60, 180, 300, 600, 1200].includes(sn)) return;
  ayarYaz({ onbellekSn: sn });
  vekilAyarla({ onbellek: sn });
  mpv?.set('demuxer-readahead-secs', sn).catch(() => {});
});
// İnternet hızı (Mbps, elle): "Oda aç" otomatik seçimi tam hızda bile izlenemeyecek kaynakları denemiyor.
// Sayfa bunu okuyup sunucuya da yazıyor (panel/js/new.js); null = girilmedi.
ipcMain.on('kabuk:internet-mbps', (e) => { e.returnValue = Number(ayarOku().internetMbps) || null; });
ipcMain.on('kabuk:internet-mbps-yaz', (_e, mbps) => {
  const n = Number(mbps);
  ayarYaz({ internetMbps: n >= 1 && n <= 10_000 ? Math.round(n * 10) / 10 : null });
});
// Hızlı başlat (bkz. tamponAyarla): ana ekrandan açılıp kapatılıyor, varsayılan açık.
// Uygulama açılınca sunucu kendiliğinden başlasın (varsayılan açık; Ayarlar'dan kapatılır).
ipcMain.on('kabuk:sunucu-oto', (e) => { e.returnValue = ayarOku().sunucuOtoAc !== false; });
ipcMain.on('kabuk:sunucu-oto-yaz', (_e, acik) => ayarYaz({ sunucuOtoAc: acik !== false }));
ipcMain.on('kabuk:zoom', (e) => { e.returnValue = Number(ayarOku().zoom) || 1; });
ipcMain.on('kabuk:zoom-yaz', (_e, z) => { if (z >= 0.5 && z <= 2.5) ayarYaz({ zoom: z }); });
ipcMain.on('kabuk:oto-tam-ekran', (e) => { e.returnValue = ayarOku().otoTamEkran !== false; });
ipcMain.on('kabuk:oto-tam-ekran-yaz', (_e, acik) => ayarYaz({ otoTamEkran: acik !== false }));
ipcMain.on('kabuk:hizli-baslat', (e) => { e.returnValue = hizliBaslat(); });
ipcMain.on('kabuk:hizli-baslat-yaz', (_e, acik) => ayarYaz({ hizliBaslat: acik === true }));
// Otomatik kaynak seçimi (Oda aç): ana ekrandan açılıp kapatılıyor, varsayılan açık.
ipcMain.on('kabuk:oto', (e) => { e.returnValue = ayarOku().otoKaynak !== false; });
// Video önbelleği boyutu (GB, elle; 0 = kapalı), bu bilgisayarın motoruna göre:
// - uygulama kendi TorrServer'ını açtıysa onun önbelleği (motor-baslat.cjs),
// - 11470'te Stremio varsa Stremio'nun kendi ayarı (cacheSize),
// - 11470 aynı bilgisayardaki Birlikte İzle sunucusunun motoruysa oda ayarlarından (host) değişiyor.
const GB = 1024 ** 3;
async function yerelMotor() {
  try {
    return (await (await fetch('http://127.0.0.1:11470/settings', { signal: AbortSignal.timeout(3000) })).json())?.values || null;
  } catch {
    return null;
  }
}
ipcMain.handle('kabuk:video-onbellek', async () => {
  if (typeof motor !== 'undefined' && motor) {
    return { motor: 'torrserver', gb: motor.onbellekGb(), klasor: motor.onbellekKlasoru?.() || null, secilen: ayarOku().videoOnbellekKlasor || null };
  }
  // Kendi motorumuz açılırken 11470'teki taklit "torrserver" der ama sunucununki değil: bekle.
  if (typeof motorAciliyor !== 'undefined' && motorAciliyor) return { motor: 'aciliyor' };
  const v = await yerelMotor();
  if (!v) return { motor: null };
  if (v.motor === 'torrserver') return { motor: 'sunucu' };
  return { motor: 'stremio', gb: v.cacheSize === null ? null : Math.round((Number(v.cacheSize) / GB) * 10) / 10 };
});
// Açılış ekranındaki motor rozeti: bu bilgisayarda videoyu hangi motor indiriyor.
// kendi: uygulamanın TorrServer'ı · sunucu: aynı bilgisayardaki Birlikte İzle sunucusunun motoru ·
// stremio: Stremio · aciliyor · yok (11470'te kimse yok, motor da açılamadı).
ipcMain.handle('kabuk:motor', async () => {
  const bekci = ayarOku().motorBekci === true;
  // Ayrıntı alınamazsa da rozet boş kalmasın (eski motor dosyasında durum() yoktu, hata fırlatıyordu).
  if (motor) return { tur: 'kendi', bekci, ...(await Promise.resolve().then(() => motor.durum()).catch(() => ({}))) };
  if (motorAciliyor) return { tur: 'aciliyor', bekci };
  const v = await yerelMotor();
  if (!v) return { tur: 'yok', bekci, hata: motorHatasi };
  return { tur: v.motor === 'torrserver' ? 'sunucu' : 'stremio', bekci };
});
ipcMain.handle('kabuk:motor-bekci-yaz', (_e, acik) => {
  ayarYaz({ motorBekci: acik === true });
  return { ok: true };
});
ipcMain.handle('kabuk:video-onbellek-yaz', async (_e, gb) => {
  gb = Number(gb);
  if (!(gb >= 0 && gb <= 1000)) return { error: 'badValue' };
  if (typeof motor !== 'undefined' && motor) {
    ayarYaz({ videoOnbellekGb: gb });
    await motor.onbellekAyarla(gb);
    return { ok: true, gb };
  }
  try {
    const r = await fetch('http://127.0.0.1:11470/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheSize: Math.round(gb * GB) }), signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return { error: 'stremio' };
  } catch {
    return { error: 'stremio' };
  }
  const v = await yerelMotor();
  return { ok: true, gb: v?.cacheSize === null ? null : Math.round((Number(v?.cacheSize) / GB) * 10) / 10 };
});
// Klasör seçme penceresi (açılış ekranı ve sunucu paneli: önbellek yeri). Seçilen yol aşağıda
// önbellek yeri olarak kabul ediliyor; başka bir sayfa kendi uydurduğu yolu veremesin.
let sonSecilenKlasor = null;
ipcMain.handle('kabuk:klasor-sec', async (e, baslik) => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: String(baslik || 'Klasör seç').slice(0, 80), properties: ['openDirectory', 'createDirectory'],
  });
  sonSecilenKlasor = r.canceled ? null : r.filePaths[0] || null;
  return sonSecilenKlasor;
});
// Kendi motorunun video önbelleğinin yeri: seçilen klasörün içinde "BirlikteIzle-onbellek" (null = varsayılan).
ipcMain.handle('kabuk:video-onbellek-yer', async (_e, secilen) => {
  if (!motor?.onbellekTasi) return { error: 'motor' };
  if (secilen !== null && secilen !== sonSecilenKlasor) return { error: 'yol' };
  const r = await motor.onbellekTasi(secilen);
  if (r.ok) ayarYaz({ videoOnbellekKlasor: secilen });
  return r;
});
ipcMain.on('kabuk:oto-yaz', (_e, acik) => ayarYaz({ otoKaynak: Boolean(acik) }));
// Ad: ilk açılışta soruluyor, odalara bu adla sorulmadan giriliyor.
ipcMain.on('kabuk:isim', (e) => { e.returnValue = ayarOku().isim || null; });
ipcMain.on('kabuk:isim-yaz', (_e, ad) => {
  const temiz = String(ad || '').trim().slice(0, 30);
  if (temiz) ayarYaz({ isim: temiz });
});
// Tercih edilen görüntü kalitesi: açılış ekranında bir kez soruluyor, oda sayfası da okuyor.
ipcMain.on('kabuk:kalite', (e) => { e.returnValue = ayarOku().kalite || null; });
ipcMain.on('kabuk:kalite-yaz', (_e, q) => {
  if (['2160p', '1080p', '720p'].includes(q)) ayarYaz({ kalite: q });
});
// "Güncellemeleri denetle" düğmesi: yerel sunucu (host'ta) ya da bulunan sunucu.
ipcMain.handle('kabuk:guncelle', async () => {
  const liste = await sunucular();
  let kok = null;
  for (const s of liste) {
    try {
      const yanit = await fetch(`${s}/indir/surum.json`, { signal: AbortSignal.timeout(4000) });
      if (yanit.ok) { kok = s; break; }
    } catch { /* sıradaki */ }
  }
  await guncellemeDenetle(kok, { elle: true });
});

// birlikteizle://<oda adresi> bağlantısı uygulamayı açsın. Tarayıcıdaki "Masaüstü
// uygulamasında aç" düğmesi bu şemayı kullanıyor.
const SEMA = 'birlikteizlemotor';

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
  if (!ana) return;
  // Bağlantısız ikinci açılış (kısayola tekrar tıklamak) da açık pencereyi öne getirsin;
  // eskiden hiçbir şey olmuyordu ve uygulama açılmamış gibi görünüyordu.
  if (url) ana.loadURL(url);
  if (ana.isMinimized()) ana.restore();
  ana.show();
  ana.focus();
}

// Tek örnek: ikinci kez açılınca (şema bağlantısıyla) çalışan pencere odaya gider.
const tekOrnek = app.requestSingleInstanceLock();
if (!tekOrnek) app.quit();
else {
  app.on('second-instance', (_e, arglar) => {
    if (process.env.KABUK_DEBUG) console.log('ikinci-ornek', JSON.stringify(arglar));
    // Sunucu kısayolu (baslat.vbs) paneli istiyor: oynatıcı penceresine dokunma (odada olabilir).
    tepsidenAc(); // tepsiye küçültülmüşse pencereyi geri getir
    if (arglar.includes('--panel')) return panelAc();
    odayaGit(semadanUrl(arglar));
  });
}

// Sunucu paneli (127.0.0.1:7301) Edge yerine uygulamanın içinde, aynı pencerede: açılış ekranındaki
// "Sunucu" düğmesi ve sunucu kısayolu (baslat.vbs → "--panel"). Panel sayfalarında "← Ana ekran"
// düğmesi var (onyukleme-kabuk.cjs). Odadayken (video oynarken) ayrı pencerede açılır, oda bozulmasın.
// Kurulumsuz uygulamada sunucunun kodu da yanında (depo kökü): sunucu kapalıysa düğme onu başlatır.
const PANEL_URL = 'http://127.0.0.1:7301/';
// Kurulu uygulamada sunucu kodu resources/sunucu-paket'te (masaustu/sunucu-hazirla.cjs); Node yerine uygulamanın
// kendi exe'si ELECTRON_RUN_AS_NODE ile çalışır, veri kullanıcı klasörüne (güncellemede silinmesin) yazılır.
const PAKET_KOK = path.join(process.resourcesPath || '', 'sunucu-paket');
const SUNUCU_PAKETLI = fs.existsSync(path.join(PAKET_KOK, 'server.js'));
const SUNUCU_KOK = SUNUCU_PAKETLI ? PAKET_KOK : path.join(__dirname, '..', '..');
const SUNUCU_VERI = SUNUCU_PAKETLI ? path.join(app.getPath('userData'), 'sunucu-veri') : path.join(SUNUCU_KOK, 'data');
const sunucuKoduVar = () => fs.existsSync(path.join(SUNUCU_KOK, 'server.js')) && fs.existsSync(path.join(SUNUCU_KOK, 'node_modules'));
async function sunucuCalisiyor() {
  try {
    return (await fetch(`${PANEL_URL}api/ping`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
// baslat.vbs gibi arka planda açar: uygulama kapansa da çalışır (kapatmak için panelde ⏻ Kapat).
// Açılışı TorrServer'ı da beklediği için 30 sn'ye kadar sürebilir.
async function sunucuBaslat() {
  if (await sunucuCalisiyor()) return { ok: true };
  if (!sunucuKoduVar()) return { error: 'kodYok' };
  try {
    fs.mkdirSync(path.join(SUNUCU_VERI, 'logs'), { recursive: true });
    const cikti = fs.openSync(path.join(SUNUCU_VERI, 'logs', 'stdout.log'), 'a');
    const ortam = { ...process.env };
    delete ortam.ELECTRON_RUN_AS_NODE;
    if (SUNUCU_PAKETLI) { ortam.ELECTRON_RUN_AS_NODE = '1'; ortam.DATA_DIR = SUNUCU_VERI; }
    require('node:child_process').spawn(SUNUCU_PAKETLI ? process.execPath : 'node', ['server.js'], {
      cwd: SUNUCU_KOK, detached: true, stdio: ['ignore', cikti, cikti], windowsHide: true, env: ortam,
    }).unref();
    fs.closeSync(cikti);
    gunluk('sunucu: uygulamadan başlatıldı');
  } catch (err) {
    gunluk(`sunucu açılamadı: ${err.message}`);
    return { error: 'acilmadi' };
  }
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await sunucuCalisiyor()) return { ok: true };
  }
  return { error: 'acilmadi' };
}
function panelAc() {
  if (!ana || ana.isDestroyed()) return;
  if (odadaMi) panelPenceresiAc(); // odadaMi: ana pencere oda sayfasında (yukarıda tutuluyor)
  else odayaGit(PANEL_URL);
}
ipcMain.on('kabuk:sunucu-kodu', (e) => { e.returnValue = sunucuKoduVar(); });
ipcMain.handle('kabuk:sunucu-ac', async () => {
  const r = await sunucuBaslat();
  if (r.ok) {
    if (odadaMi) panelAc();
    else odayaGit((await anaSayfaVar()) ? `${PANEL_URL}ana` : PANEL_URL); // Stremio tarzı ana sayfa (eski sunucuda panel)
  }
  return r;
});
let panelPencere = null;
function panelPenceresiAc() {
  if (panelPencere && !panelPencere.isDestroyed()) {
    if (panelPencere.isMinimized()) panelPencere.restore();
    panelPencere.show();
    panelPencere.focus();
    return;
  }
  panelPencere = new BrowserWindow({
    width: 1200, height: 860, backgroundColor: '#0e0f13', title: 'Birlikte İzle · Panel',
    icon: path.join(__dirname, 'simge.ico'), autoHideMenuBar: true,
  });
  panelPencere.setMenuBarVisibility(false);
  // Odaya git bağlantıları oynatıcı penceresinde, başka her şey (stremio://, dış siteler) sistemde.
  const disari = (url) => {
    if (/\/room\/[A-Z0-9]+/i.test(url) && /^https?:/.test(url)) odayaGit(url);
    else shell.openExternal(url).catch(() => {});
  };
  panelPencere.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(PANEL_URL)) return;
    e.preventDefault();
    disari(url);
  });
  panelPencere.webContents.setWindowOpenHandler(({ url }) => {
    disari(url);
    return { action: 'deny' };
  });
  panelPencere.on('closed', () => {
    panelPencere = null;
    if (ana && !ana.isDestroyed() && !ana.isVisible()) app.quit();
  });
  panelPencere.loadURL(PANEL_URL);
}
ipcMain.on('kabuk:panel-ac', () => panelAc());
// Yalnızca paketlenmiş uygulama şemayı üstlensin: geliştirme sırasında çalıştırmak
// kaydı çıplak electron.exe'ye çevirip bağlantıyı bozuyor.
if (app.isPackaged) app.setAsDefaultProtocolClient(SEMA);

// Stremio'suz çalışma: 11470'te yayın sunucusu yoksa TorrServer motoru açılıyor (bkz. motor-baslat.cjs).
let motor = null;
let motorAciliyor = true;
let motorHatasi = null;
app.on('will-quit', () => motor?.durdur());

// Uygulama kapanınca sunucu da kapansın (ayar "sunucuyu uygulamayla aç/kapat" açıkken, varsayılan).
// Sunucunun kendi /api/shutdown'ı çağrılıyor (tünel, TorrServer, indirmeler düzgün kapanır); anahtar
// panel sayfasından okunuyor. En çok 4 sn beklenir, sonra uygulama yine kapanır.
async function sunucuKapat() {
  const http = require('node:http');
  const istek = (yol, yontem, basliklar = {}) => new Promise((coz) => {
    const r = http.request({ host: '127.0.0.1', port: 7301, path: yol, method: yontem, headers: basliklar, timeout: 2500 }, (cevap) => {
      let govde = '';
      cevap.on('data', (p) => { govde += p; });
      cevap.on('end', () => coz({ kod: cevap.statusCode, govde }));
    });
    r.on('error', () => coz(null));
    r.on('timeout', () => { r.destroy(); coz(null); });
    r.end();
  });
  const sayfa = await istek('/ana', 'GET'); // '/' artık /sunucu'ya yönleniyor (gövde boş, anahtar bulunamaz)
  const anahtar = sayfa?.govde.match(/name="panel-key" content="([^"]+)"/)?.[1];
  if (!anahtar) return;
  await istek('/api/shutdown', 'POST', { 'x-panel-key': anahtar, origin: 'http://127.0.0.1:7301' });
  gunluk('sunucu: uygulama kapanırken kapatıldı');
}
// Kapanış iki yoldan tetikleniyor (pencere 'closed' + 'window-all-closed'): ikinci app.quit() sunucu
// kapanmadan uygulamayı bitirmesin diye, iş bitene kadar her before-quit engelleniyor.
let sunucuKapanis = 'yok'; // yok -> suruyor -> bitti
let cikiyor = false; // gerçekten çıkılıyor: pencere 'close' olayı artık engellenmez, tepsi simgesi kaldırılır
app.on('before-quit', (e) => {
  cikiyor = true;
  tepsi?.destroy();
  tepsi = null;
  // İkinci örnek (tek örnek kilidini alamayan) hemen kapanıyor: o kapanış sunucuyu kapatmamalı.
  if (!tekOrnek || sunucuKapanis === 'bitti' || ayarOku().sunucuOtoAc === false) return;
  e.preventDefault();
  if (sunucuKapanis === 'suruyor') return;
  sunucuKapanis = 'suruyor';
  sunucuCalisiyor()
    .then((acik) => (acik ? Promise.race([sunucuKapat(), new Promise((r) => setTimeout(r, 4000))]) : null))
    .catch(() => {})
    .finally(() => { sunucuKapanis = 'bitti'; app.quit(); });
});

app.whenReady().then(() => {
  if (!tekOrnek) return; // pencere açmadan kapanıyoruz
  motoruHazirla({
    klasor: app.getPath('userData'),
    gunluk,
    onbellekGb: ayarOku().videoOnbellekGb ?? 5,
    onbellekKlasor: ayarOku().videoOnbellekKlasor || null,
    bekci: () => ayarOku().motorBekci === true,
    onBirak: () => {
      motor = null;
      gunluk('motor: 11470 bu bilgisayardaki sunucuya bırakıldı');
    },
  })
    .then((m) => {
      motor = m;
      if (m) gunluk('motor: TorrServer açıldı (Stremio yok)');
    })
    .catch((err) => {
      motorHatasi = err.message;
      gunluk(`motor açılamadı: ${err.message}`);
    })
    .finally(() => { motorAciliyor = false; });
  // Sunucu kısayolu "--panel" ile açtıysa pencere doğrudan panelle açılır ("← Ana ekran" ile dönülür).
  const panelIle = process.argv.includes('--panel');
  ana = new BrowserWindow({
    width: 1280, height: 800, backgroundColor: '#12122a', title: 'Birlikte İzle',
    icon: path.join(__dirname, 'simge.ico'),
    // Windows'un mavi/gri başlık çubuğu yerine uygulamanın rengi: çubuk sayfanın parçası (sürükleme alanı sayfa
    // stilinde, bkz. onyukleme-kabuk.cjs barStili), kapat/küçült/büyüt düğmeleri sağ üstte temaya boyalı.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 40 }, // saydam: afişli sayfalarda (detay) düz bir blok görünmesin
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

  // Saydam kontrol çubuğu penceresi: videonun üstünde (video penceresinin sahipli penceresi,
  // hep onun üstünde), odak almıyor. İçeriği oda sayfasının çubuğunun aynası (bkz. kontrol-onyukleme.cjs).
  kontrolPenceresi = new BrowserWindow({
    parent: videoPenceresi, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'kontrol-onyukleme.cjs'), contextIsolation: false, sandbox: false },
  });
  geriPenceresi = new BrowserWindow({
    parent: videoPenceresi, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'geri-onyukleme.cjs'), contextIsolation: false, sandbox: false },
  });
  geriPenceresi.loadFile(path.join(__dirname, 'geri.html'));
  ipcMain.on('geri:tikla', () => {
    ana?.webContents.executeJavaScript("document.getElementById('genis-geri')?.click()", true).catch(() => {});
  });
  kontrolPenceresi.loadFile(path.join(__dirname, 'kontrol.html'));
  kontrolPenceresi.webContents.on('did-finish-load', () => ana?.webContents.send('kabuk:kontrol-yenile'));
  ipcMain.on('kabuk:kontrol-html', (_e, veri) => {
    if (kontrolPenceresi && !kontrolPenceresi.isDestroyed()) kontrolPenceresi.webContents.send('kontrol:html', veri);
  });
  ipcMain.on('kontrol:olay', (_e, olay) => {
    if (!ana || ana.isDestroyed()) return;
    // Tıklama kullanıcı hareketi sayılsın (userGesture): tam ekran düğmesine çıkar çıkmaz yeniden
    // basınca istek "Permissions check failed" ile reddediliyor, düğme birkaç basış çalışmıyordu.
    if (olay?.tur === 'click') {
      ana.webContents.executeJavaScript(`window.__kabukKontrolOlay?.(${JSON.stringify(olay)})`, true).catch(() => {});
    } else ana.webContents.send('kabuk:kontrol-olay', olay);
  });

  // Canlı yayın sesi: yalnız mpv'nin sesi (tüm bilgisayar sesi değil). Yardımcı PCM veriyor,
  // sayfaya parça parça gidiyor; sayfa bunu yayının ses izine çeviriyor (bkz. onyukleme-kabuk.cjs).
  let uygulamaSesi = null;
  ipcMain.handle('kabuk:uygulama-sesi-baslat', async () => {
    uygulamaSesi?.durdur();
    uygulamaSesi = null;
    const pid = mpv?.pid?.();
    if (!pid) return { error: 'mpvYok' };
    try {
      uygulamaSesi = await require('./uygulama-sesi.cjs').baslat({
        pid,
        klasor: app.getPath('userData'),
        onVeri: (parca) => { if (ana && !ana.isDestroyed()) ana.webContents.send('kabuk:uygulama-sesi-veri', parca); },
        onBitti: () => { uygulamaSesi = null; },
      });
      return { ok: true };
    } catch (err) {
      console.error('Uygulama sesi yakalanamadı:', err.message);
      return { error: 'yakalanamadi', detay: err.message };
    }
  });
  ipcMain.on('kabuk:torrent-kapat', (_e, infoHash) => {
    if (!/^[0-9a-f]{40}$/i.test(infoHash)) return;
    fetch(`http://127.0.0.1:11470/${infoHash.toLowerCase()}/remove`, { signal: AbortSignal.timeout(4000) }).catch(() => {});
  });
  ipcMain.on('kabuk:uygulama-sesi-durdur', () => {
    uygulamaSesi?.durdur();
    uygulamaSesi = null;
  });

  // Canlı yayın (public/js/yayin.js): oda sayfası getDisplayMedia isteyince seçici göstermeden
  // oynatıcı penceresini (mpv burada çiziyor) ve sistem sesini ver. Bu pencere yakalanabilir
  // pencereler listesinde görünmüyor (sahipli, görev çubuğunda yok) ama kimliğiyle istenince
  // yakalanıyor - Faz 0'da ölçüldü: görüntü ve ses geliyor. Ana pencereyi yakalamak işe yaramaz:
  // mpv ayrı pencerede çizdiği için orada yalnız boş arka plan görünüyor.
  // Not: diyalog açıkken mpv penceresi gizleniyor (ORTU), o sırada yayın görüntüsü donar.
  session.defaultSession.setDisplayMediaRequestHandler((istek, cevap) => {
    const ust = ana && !ana.isDestroyed() ? ana.webContents.mainFrame : null;
    const kendiSayfamiz = Boolean(istek.frame && ust
      && istek.frame.processId === ust.processId && istek.frame.routingId === ust.routingId);
    if (!kendiSayfamiz || !videoPenceresi || videoPenceresi.isDestroyed()) {
      cevap({});
      return;
    }
    cevap({ video: { id: `window:${hwndOf(videoPenceresi)}:0`, name: 'Birlikte İzle' }, audio: 'loopback' });
  });

  ipcMain.on('kabuk:video-alani', async (_e, rect) => {
    sonAlan = rect;
    const simdi = Date.now();
    // Boyut sürüklenirken ölçümler kare kare geliyor; yerleştirme ~60/sn'ye iner, son ölçüm gecikmeli hizala ile uygulanır.
    if (!boyutDegisiyor() || simdi - sonHizalama >= 16) { sonHizalama = simdi; hizala(rect); }
    if (!mpv) await mpvBaslat();
    // Simge durumundayken göstermeye çalışmak görev çubuğunu yakıp söndürüyordu;
    // karar videoGorunurluk'te, gösterirken de odak çalınmıyor (showInactive).
    videoGorunurluk();
  });
  // Diyalog açıkken mpv penceresi gizlenir; yoksa diyaloğun üstünü örter.
  ipcMain.on('kabuk:ortu', (_e, ortulu) => {
    const once = ortuluMu;
    ortuluMu = ortulu;
    videoGorunurluk();
    if (ortulu && !once) kareGoster();
    else if (!ortulu && once) ana?.webContents.send('kabuk:kare', null);
  });
  ipcMain.on('kabuk:yukleniyor', (_e, deger) => {
    yukleniyor = deger;
    videoGorunurluk();
  });
  // Canlı yayın başlamadan önce: gizli pencere yakalanamıyor ("Could not start video source").
  // Diyalog yeni kapandıysa ya da görüntü yeni geldiyse pencere birazdan görünür; 3 sn bekle.
  ipcMain.handle('kabuk:yayin-hazir', async () => {
    for (let i = 0; i < 15; i++) {
      if (videoPenceresi && !videoPenceresi.isDestroyed() && videoPenceresi.isVisible()) return { ok: true };
      await new Promise((r) => setTimeout(r, 200));
    }
    const sebep = !mpv ? 'mpvYok' : ortuluMu ? 'ortu' : yukleniyor ? 'yukleniyor' : ana?.isMinimized() ? 'kucuk' : 'gizli';
    return { ok: false, sebep };
  });
  ipcMain.on('mpv:yukle', async (_e, gelen) => {
    // Stremio adresleri ara katmandan geçiyor: ileri-geri sarmalar Stremio'da birikme yapmasın
    // (bkz. stremio-vekil.cjs).
    const url = gelen ? await vekilAdres(gelen).catch(() => gelen) : gelen;
    sonYuklenen = url || null;
    yenidenDeneme = 0;
    if (!mpv) bekleyenYukleme = url;
    else mpv.load(url).catch(() => {});
  });
  ipcMain.on('mpv:durdur', () => mpv?.command('stop').catch(() => {}));
  ipcMain.on('mpv:sar', async (_e, saniye) => {
    await mpv?.seek(saniye).catch(() => {});
    ana?.webContents.send('mpv:sarildi');
  });
  ipcMain.on('mpv:ozellik', (_e, ad, deger) => {
    // Ses gibi ayarlar mpv açılmadan gelebiliyor; son değerleri saklayıp açılışta uyguluyoruz.
    if (ad === 'volume' || ad === 'mute') sonOzellikler[ad] = deger;
    mpv?.set(ad, deger).catch(() => {});
  });
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
  ipcMain.on('mpv:altyazi2', async (_e, metin) => {
    const yeni = path.join(os.tmpdir(), `birlikte-izle-altyazi2-${process.pid}-${++altyaziSayaci}.vtt`);
    try {
      fs.writeFileSync(yeni, metin, 'utf8');
    } catch { return; }
    altyazi2Dosyasi = yeni;
    altyaziDosyalari.push(yeni);
    await altyazi2Ekle();
  });
  ipcMain.on('mpv:altyazi2-kapat', async () => {
    altyazi2Dosyasi = null;
    sonSubPos = null; // asıl altyazı eski yerine dönsün
    await altyazi2Ekle();
  });
  ipcMain.on('mpv:altyazi2-gecikme', (_e, saniye) =>
    mpv?.set('secondary-sub-delay', Number(saniye) || 0).catch(() => {}));
  ipcMain.on('mpv:bilgi', (_e, metin) => mpv?.command('show-text', metin, 1500).catch(() => {}));
  ipcMain.on('mpv:sohbet', (_e, kim, metin) => sohbetEkle(kim, metin));
  ipcMain.on('mpv:gomulu-sec', async (_e, id) => {
    if (!mpv) return;
    if (!id) {
      await mpv.set('sid', 'no').catch(() => {});
    } else {
      await mpv.set('sid', Number(id)).catch(() => {});
      await mpv.set('sub-visibility', true).catch(() => {});
    }
    gomuluYolla();
  });
  ipcMain.on('mpv:oran', (_e, mod) => {
    sonOran = mod;
    oranUygula();
  });
  ipcMain.on('mpv:ses-sec', async (_e, id) => {
    await mpv?.set('aid', id).catch(() => {});
    sesleriYolla();
  });
  ipcMain.on('mpv:altyazi-gecikme', (_e, saniye) => mpv?.set('sub-delay', Number(saniye) || 0).catch(() => {}));
  ipcMain.handle('kabuk:vlc', (_e, url, ad, saniye) => {
    const vlc = [
      process.env.VLC_YOLU,
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'VideoLAN', 'VLC', 'vlc.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VideoLAN', 'VLC', 'vlc.exe'),
    ].find((p) => p && fs.existsSync(p));
    if (!vlc || !/^https?:\/\//.test(url)) return false;
    const args = [url, `--meta-title=${ad}`];
    if (saniye > 5) args.push(`--start-time=${Math.floor(saniye)}`);
    // Sessiz kalmamalı: VLC açılamazsa sebebi konsolda görünsün.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      require('node:child_process').spawn(vlc, args, { detached: true, stdio: 'ignore', env }).unref();
      return true;
    } catch (e) {
      console.error('vlc:', e.message);
      return false;
    }
  });
  ipcMain.on('kabuk:indir', (_e, url) => {
    if (/^https?:\/\//.test(url)) ana?.webContents.downloadURL(url);
  });
  ipcMain.on('mpv:altyazi-stil', (_e, s) => {
    sonStil = s;
    altyaziStilUygula();
  });

  // Sayfa tam ekrana geçince pencere kiosk moduna giriyor. Düz setFullScreen'de mpv'nin
  // ayrı penceresi yüzünden Windows pencereyi "tam ekran" saymıyor, görev çubuğu
  // videonun üstünde kalıyordu; kiosk ekranın tamamını alıyor.
  ana.webContents.on('enter-html-full-screen', () => {
    ana.setKiosk(true);
    ana.setAlwaysOnTop(true, 'screen-saver');
    videoPenceresi?.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => ana?.webContents.send('kabuk:olcum-iste'), 200);
  });
  ana.webContents.on('leave-html-full-screen', () => {
    ana.setKiosk(false);
    ana.setAlwaysOnTop(false);
    videoPenceresi?.setAlwaysOnTop(false);
    setTimeout(() => ana?.webContents.send('kabuk:olcum-iste'), 200);
  });

  for (const olay of ['resize', 'move', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']) {
    // Son ölçümü bir kez de gecikmeli istiyoruz (boyut değişimi bitince düzelsin),
    // ama üst üste binen istekleri biriktirmiyoruz.
    let gecikmeli = null;
    ana.on(olay, () => {
      // Pencere taşınınca sayfadaki ölçü değişmiyor, dolayısıyla yeni ölçüm gelmiyor:
      // mpv penceresini son bilinen alanla hemen kendimiz yerine koyuyoruz.
      const simdi = Date.now();
      sonBoyutOlayi = simdi;
      // Windows sürüklerken saniyede yüzlerce olay veriyor: pencere yerleştirmeyi ~60/sn, sayfaya ölçüm isteğini ~20/sn ile sınırlıyoruz.
      // Taşırken (move) sınır yok: ayrı pencereler sahibini zaten bir tık geriden izliyor, her olayda yerine koyuyoruz.
      if (sonAlan && (olay === 'move' || simdi - sonHizalama >= 16)) { sonHizalama = simdi; hizala(sonAlan); }
      if (simdi - sonOlcumIstegi >= 50) { sonOlcumIstegi = simdi; ana.webContents.send('kabuk:olcum-iste'); }
      clearTimeout(gecikmeli);
      gecikmeli = setTimeout(() => {
        sonBoyutOlayi = 0;
        sonBicim = '';
        sonKontrolBicim = '';
        if (sonAlan) hizala(sonAlan);
        ana?.webContents.send('kabuk:olcum-iste');
      }, 150);
    });
  }
  // Simge durumuna inince mpv penceresi ekranda kalmasın; geri gelince yerine dönsün.
  ana.on('minimize', () => videoPenceresi?.hide());
  ana.on('restore', videoGorunurluk);

  // Pencerenin X'ine basılınca: indirme sürüyorsa uyar (tepsiye küçült / kapat / vazgeç); yoksa normal kapanır
  // (uygulama ve sunucu birlikte kapanır).
  ana.on('close', (e) => {
    if (cikiyor || kapatmaOnayli) return;
    e.preventDefault();
    kapatmaSor();
  });
  ana.on('closed', () => {
    clearInterval(durumZamanlayici);
    for (const dosya of altyaziDosyalari.splice(0)) fs.rmSync(dosya, { force: true });
    mpv?.stop().catch(() => {});
    app.quit();
  });
  // Dış bağlantılar (yardım linkleri) uygulamanın içinde değil tarayıcıda açılsın.
  // Odadan başka sayfaya geçilince (Geri, oda kapandı) video penceresi ve delikleri kalmasın,
  // oynatma dursun: yoksa kaynak listesinin üstünde siyah bir kutu asılı kalıyordu.
  ana.webContents.on('did-navigate', (_e, url) => {
    odadaMi = /\/room\/[A-Z0-9]{6}/i.test(url);
    if (!odadaMi) {
      sonAlan = null;
      sonYuklenen = null;
      mpv?.command('stop').catch(() => {});
    }
    videoGorunurluk();
  });
  ana.webContents.on('did-finish-load', () => {
    const adres = ana.webContents.getURL();
    odaSayfasiYuklendi(adres);
  });
  // stremio:// gibi uygulama bağlantıları ("Stremio'ya bağlan") işletim sistemine gitsin.
  ana.webContents.on('will-navigate', (e, url) => {
    if (/^https?:|^file:/.test(url)) return;
    e.preventDefault();
    shell.openExternal(url).catch(() => {});
  });
  ana.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const semaUrl = semadanUrl(process.argv);
  if (semaUrl) ana.loadURL(semaUrl);
  else if (ODA_URL) ana.loadURL(ODA_URL);
  else if (panelIle) ana.loadURL(PANEL_URL);
  else anaEkranAc({ acilis: true });
});

// Ana ekran: sunucu bu bilgisayarda çalışıyorsa Stremio tarzı ana sayfa (PANEL_URL/ana), yoksa açılış
// ekranı (misafir ya da sunucusuz kullanım). Uygulama ilk açılırken ayar açıksa ve sunucu kodu varsa
// sunucu da kendiliğinden başlatılır; o sırada açılış ekranı "sunucu açılıyor" der.
async function anaEkranAc({ acilis = false } = {}) {
  if (!ana || ana.isDestroyed()) return;
  // Eski açılış ekranı yok: sunucu çalışıyorsa ana sayfa, değilse bekleme ekranı (hata olursa aynı ekranda
  // mesaj + "Yeniden dene").
  const hata = (kod) => ana.loadFile(path.join(__dirname, 'acilis.html'), { query: { hata: kod } });
  if (await sunucuCalisiyor()) return (await anaSayfaVar()) ? ana.loadURL(`${PANEL_URL}ana`) : hata('eski');
  ana.loadFile(path.join(__dirname, 'acilis.html'));
  const r = await sunucuBaslat();
  if (ana.isDestroyed()) return;
  if (r.ok) ana.loadURL(`${PANEL_URL}ana`);
  else hata(r.error === 'kodYok' ? 'kodYok' : 'acilmadi');
}
ipcMain.on('kabuk:cik', () => app.quit());
ipcMain.on('kabuk:yeniden-dene', () => anaEkranAc({ acilis: true }));
async function anaSayfaVar() {
  try {
    return (await fetch(`${PANEL_URL}ana`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

ipcMain.on('kabuk:odaya-git', (_e, url) => ana?.loadURL(url));
// Oda kapandı: oynatmayı durdur, açılış ekranına dön (açık odalar listesi tazelenir).
ipcMain.on('kabuk:baslangic', () => {
  if (!ana) return;
  if (ana.isKiosk()) ana.setKiosk(false);
  sonYuklenen = null;
  mpv?.command('stop').catch(() => {});
  yukleniyor = false;
  videoPenceresi?.hide();
  anaEkranAc();
});
app.on('window-all-closed', () => app.quit());
