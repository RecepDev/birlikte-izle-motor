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
const { vekilAdres } = require('./stremio-vekil.cjs');

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
function videoGorunurluk() {
  if (!videoPenceresi || videoPenceresi.isDestroyed() || !ana) return;
  if (!mpv || ortuluMu || yukleniyor || ana.isMinimized()) {
    videoPenceresi.hide();
    return;
  }
  if (sonAlan) hizala(sonAlan);
  if (!videoPenceresi.isVisible()) videoPenceresi.showInactive();
}
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

// Çubuk önizlemesi: tarayıcının <video>'su HEVC/MKV açamadığı için kareyi ayrı, görünmez
// bir mpv çıkarıyor. Bu mpv açık kalıyor: dosya bir kez açılıyor, sonraki her kare yalnızca
// en yakın anahtar kareye atlayıp küçültülmüş ekran görüntüsü almak (her seferinde yeni
// süreç açıp dosyayı baştan okumaktan kat kat hızlı). Açılamazsa tek seferlik sürece düşüyor.
// Aynı anda tek istek; beklerken gelenlerden yalnızca sonuncusu işleniyor.
const onizlemeOnbellek = new Map();
let onizlemeSuruyor = false;
let onizlemeSiradaki = null;
let kucuk = null; // { mpv, pencere, url }
let kucukHazirlaniyor = null;

async function kucukMpv() {
  if (kucuk?.mpv) return kucuk;
  if (kucukHazirlaniyor) return kucukHazirlaniyor;
  kucukHazirlaniyor = (async () => {
    const { createMpv } = await import('../mpv.js');
    // mpv'nin çizeceği, hiç gösterilmeyen küçük pencere.
    const pencere = new BrowserWindow({ show: false, width: 320, height: 180, frame: false, skipTaskbar: true, focusable: false });
    const m = createMpv({
      binary: MPV,
      pipeName: `birlikte-izle-onizleme-${process.pid}`,
      args: [
        `--wid=${hwndOf(pencere)}`, '--no-config', '--pause=yes', '--no-audio', '--sid=no', '--osd-level=0',
        '--hr-seek=no', '--cache=no', '--demuxer-readahead-secs=0', '--ytdl=no',
        // 4K HEVC anahtar karesini ekran kartı çözüyor (işlemciyle 4-5 kat yavaş); küçültme
        // için kare belleğe kopyalanıyor. Yalnızca anahtar kareler çözülüyor.
        '--hwdec=auto-copy-safe', '--vd-lavc-skipframe=nonkey',
        // Dosyayı açarken uzun çözümleme yok: ilk kare daha çabuk.
        '--demuxer-lavf-analyzeduration=0.5', '--demuxer-lavf-probescore=24',
        '--vd-lavc-skiploopfilter=all', '--vd-lavc-fast', '--vd-lavc-threads=2', '--vf=scale=288:-2',
        '--screenshot-format=jpg', '--screenshot-jpeg-quality=70',
      ],
    });
    await m.start();
    m.on('exit', () => {
      if (kucuk?.mpv === m) kucuk = null;
      if (!pencere.isDestroyed()) pencere.destroy();
    });
    kucuk = { mpv: m, pencere, url: null };
    return kucuk;
  })();
  try {
    return await kucukHazirlaniyor;
  } finally {
    kucukHazirlaniyor = null;
  }
}

// Kare hazır olunca mpv 'playback-restart' yolluyor (yüklemede ve her atlamada).
function kareBekle(m, ms) {
  return new Promise((resolve) => {
    const bitti = (ok) => {
      clearTimeout(zaman);
      m.off('playback-restart', tamam);
      m.off('end-file', hata);
      resolve(ok);
    };
    const tamam = () => bitti(true);
    const hata = () => bitti(false);
    const zaman = setTimeout(() => bitti(false), ms);
    m.on('playback-restart', tamam);
    m.on('end-file', hata);
  });
}

async function onizlemeCikar(url, saniye) {
  const k = await kucukMpv();
  const hedef = String(Math.max(0, Math.floor(saniye)));
  let ok;
  if (k.url !== url) {
    k.url = url;
    const bekle = kareBekle(k.mpv, 15_000);
    await k.mpv.command('loadfile', url, 'replace', -1, `start=${hedef}`);
    ok = await bekle;
    if (!ok) k.url = null;
  } else {
    const bekle = kareBekle(k.mpv, 8_000);
    await k.mpv.command('seek', hedef, 'absolute+keyframes');
    ok = await bekle;
  }
  if (!ok) return null;
  const dosya = path.join(os.tmpdir(), `bi-onizleme-${process.pid}.jpg`);
  await k.mpv.command('screenshot-to-file', dosya, 'video');
  kucukKapatZamanla();
  const veri = fs.readFileSync(dosya);
  fs.rm(dosya, { force: true }, () => {});
  return `data:image/jpeg;base64,${veri.toString('base64')}`;
}

// Açık kalan önizleme bağlantısı Stremio'da ikinci bir "şuradan oku" isteği gibi duruyor:
// Stremio hızı o noktayla oynatılan yer arasında bölüyor, asıl video takılıyordu.
// Son önizlemeden 4 sn sonra dosya kapatılıyor (süreç açık kalıyor, yeniden açmak hızlı).
let kucukZamanlayici = null;
function kucukKapatZamanla() {
  clearTimeout(kucukZamanlayici);
  kucukZamanlayici = setTimeout(() => {
    if (!kucuk?.mpv || onizlemeSuruyor) return;
    kucuk.url = null;
    kucuk.mpv.command('stop').catch(() => {});
  }, 4000);
}

// Kalıcı mpv açılamazsa: her kare için tek seferlik süreç (yavaş ama çalışır).
function onizlemeTekSefer(url, saniye) {
  return new Promise((resolve) => {
    const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-onizleme-'));
    const cocuk = require('node:child_process').spawn(MPV, [
      url, '--no-config', '--really-quiet', '--no-audio', '--sid=no', '--hr-seek=no', `--start=${Math.floor(saniye)}`,
      '--frames=1', '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=70', `--vo-image-outdir=${klasor}`,
      '--vf=scale=320:-2', '--hwdec=no', '--ytdl=no',
    ], { windowsHide: true, stdio: 'ignore' });
    const bitir = () => {
      clearTimeout(zaman);
      let sonuc = null;
      try {
        const dosya = fs.readdirSync(klasor).find((f) => f.endsWith('.jpg'));
        if (dosya) sonuc = `data:image/jpeg;base64,${fs.readFileSync(path.join(klasor, dosya)).toString('base64')}`;
      } catch { /* kare çıkmadı */ }
      fs.rm(klasor, { recursive: true, force: true }, () => {});
      resolve(sonuc);
    };
    const zaman = setTimeout(() => cocuk.kill(), 10_000);
    cocuk.on('exit', bitir);
    cocuk.on('error', bitir);
  });
}
let kaliciBozuk = false;
let sonOnbellekSn = 0;
async function onizleme(gelenUrl, saniye) {
  const url = await vekilAdres(gelenUrl).catch(() => gelenUrl);
  if (!/^https?:\/\//.test(url)) return null;
  // Asıl videonun önünde 30 sn'den az hazır veri varken önizleme torrent'ten parça
  // istemesin: Stremio o parçalara da hız ayırıyor, oynatma takılıyordu.
  if (mpv && sonYuklenen && sonOnbellekSn < 30) return null;
  const anahtar = `${url}|${Math.round(saniye)}`;
  if (onizlemeOnbellek.has(anahtar)) return onizlemeOnbellek.get(anahtar);
  if (onizlemeSuruyor) {
    // Öncekini bekleyen istek varsa boşa çıkıyor: yalnızca en son istenen kare önemli.
    onizlemeSiradaki?.resolve(null);
    return new Promise((resolve) => { onizlemeSiradaki = { url, saniye, resolve }; });
  }
  onizlemeSuruyor = true;
  let sonuc = null;
  if (!kaliciBozuk) {
    sonuc = await onizlemeCikar(url, saniye).catch((e) => {
      // Gizli pencerede çizim ya da IPC çalışmıyorsa bir daha denemiyoruz.
      console.error('onizleme:', e.message);
      kaliciBozuk = true;
      kucuk?.mpv.stop().catch(() => {});
      return null;
    });
  }
  if (kaliciBozuk) sonuc = await onizlemeTekSefer(url, saniye);
  if (sonuc) {
    onizlemeOnbellek.set(anahtar, sonuc);
    if (onizlemeOnbellek.size > 300) onizlemeOnbellek.delete(onizlemeOnbellek.keys().next().value);
  }
  onizlemeSuruyor = false;
  const sira = onizlemeSiradaki;
  onizlemeSiradaki = null;
  if (sira) onizleme(sira.url, sira.saniye).then(sira.resolve);
  return sonuc;
}

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
  const anahtar = `${pos}|${bosluk}`;
  if (anahtar === sonSubPos) return;
  sonSubPos = anahtar;
  mpv?.set('sub-margin-y', bosluk).catch(() => {});
  mpv?.set('sub-pos', pos).catch((e) => console.error('altyazi-stil sub-pos', e.message));
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
  if (!(simdiki.x === yeni.x && simdiki.y === yeni.y && simdiki.width === yeni.width && simdiki.height === yeni.height)) {
    videoPenceresi.setBounds(yeni);
  }
  const delikler = (rect.delikler || (rect.delik ? [rect.delik] : []))
    .map((d) => ({ ...d, x: b.x + d.x - yeni.x, y: b.y + d.y - yeni.y }));
  delikAc(yeni, delikler);
}

// HTML (kontrol kutuları, tam ekranda kontrol çubuğu) mpv'nin üstünde görünsün diye mpv
// penceresinin o kısımlarını kesiyoruz (pencere biçimi). Video küçülmüyor; altyazının
// yeri değişmiyor. Birden çok delik: pencere yatay şeritlere bölünüp her şeritte
// deliklerin dışında kalan aralıklar bırakılıyor.
let sonBicim = '';
function delikAc(boyut, delikler) {
  const w = boyut.width;
  const h = boyut.height;
  const kutular = (delikler || []).map((d) => ({
    sol: Math.max(0, Math.round(d.x)), ust: Math.max(0, Math.round(d.y)),
    sag: Math.min(w, Math.round(d.x + d.width)), alt: Math.min(h, Math.round(d.y + d.height)),
  })).filter((k) => k.sag > k.sol && k.alt > k.ust);
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
  const anahtar = JSON.stringify(parcalar);
  if (anahtar === sonBicim) return;
  sonBicim = anahtar;
  try {
    videoPenceresi.setShape(parcalar);
  } catch (e) {
    console.error('setShape:', e.message);
  }
}

// mpv'den okunan değerleri sayfaya iter. Sayfa bunları <video> gibi görür.
async function durumDongusu() {
  if (!mpv) return;
  try {
    const [position, duration, paused, seeking, speed, width, height, cacheEnd, idle, stalled,
      cacheSec, drops, decDrops, frames] = await Promise.all([
      mpv.get('time-pos'), mpv.get('duration'), mpv.get('pause'), mpv.get('seeking'),
      mpv.get('speed'), mpv.get('dwidth'), mpv.get('dheight'),
      mpv.get('demuxer-cache-time'), mpv.get('core-idle'), mpv.get('paused-for-cache'),
      mpv.get('demuxer-cache-duration'), mpv.get('frame-drop-count'), mpv.get('decoder-frame-drop-count'),
      mpv.get('estimated-frame-number'),
    ].map((p) => p.catch(() => null)));
    if (Number.isFinite(position) && position > 0) sonKonum = position;
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
      cacheStalled: Boolean(stalled),
      loaded: Number.isFinite(duration),
    });
  } catch { /* mpv kapanmış olabilir */ }
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
      '--cache=yes', '--demuxer-max-bytes=1GiB', '--demuxer-readahead-secs=180',
      // Önbellek biterse saniyelik kesik kesik oynamak yerine 6 sn doldurup öyle devam et.
      '--cache-pause-wait=6',
      // Ayar bilgileri (oran, ses…) görüntünün alt ortasında.
      '--osd-align-x=center', '--osd-align-y=bottom', '--osd-margin-y=48', '--osd-font-size=34',
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
  mpv.on('file-loaded', altyaziEkle);
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
  return [...new Set(['http://127.0.0.1:7000', guncel, ayar.sonSunucu].filter(Boolean))];
}
ipcMain.handle('kabuk:sunucular', () => sunucular());
ipcMain.on('kabuk:son-sunucu', (e) => { e.returnValue = ayarOku().sonSunucu || null; });
ipcMain.on('kabuk:surum', (e) => { e.returnValue = kabuk.surum; });
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
    if (!mpv) await mpvBaslat();
    // Simge durumundayken göstermeye çalışmak görev çubuğunu yakıp söndürüyordu;
    // karar videoGorunurluk'te, gösterirken de odak çalınmıyor (showInactive).
    videoGorunurluk();
  });
  // Diyalog açıkken mpv penceresi gizlenir; yoksa diyaloğun üstünü örter.
  ipcMain.on('kabuk:ortu', (_e, ortulu) => {
    ortuluMu = ortulu;
    videoGorunurluk();
  });
  ipcMain.on('kabuk:yukleniyor', (_e, deger) => {
    yukleniyor = deger;
    videoGorunurluk();
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
  ipcMain.handle('kabuk:onizleme', (_e, url, saniye) => onizleme(String(url), Number(saniye) || 0));
  // Video açılınca önizleme oynatıcısı dosyayı önceden açıyor: ilk kare beklemeden gelsin.
  ipcMain.on('kabuk:onizleme-hazirla', (_e, url) => {
    if (/^https?:\/\//.test(String(url))) onizleme(String(url), 0).catch(() => {});
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
  ana.on('restore', videoGorunurluk);

  ana.on('closed', () => {
    clearInterval(durumZamanlayici);
    for (const dosya of altyaziDosyalari.splice(0)) fs.rmSync(dosya, { force: true });
    mpv?.stop().catch(() => {});
    kucuk?.mpv.stop().catch(() => {});
    app.quit();
  });
  // Dış bağlantılar (yardım linkleri) uygulamanın içinde değil tarayıcıda açılsın.
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
  else ana.loadFile(path.join(__dirname, 'baslangic.html'));
});

ipcMain.on('kabuk:odaya-git', (_e, url) => ana?.loadURL(url));
// Oda kapandı: oynatmayı durdur, açılış ekranına dön (açık odalar listesi tazelenir).
ipcMain.on('kabuk:baslangic', () => {
  if (!ana) return;
  if (ana.isKiosk()) ana.setKiosk(false);
  sonYuklenen = null;
  mpv?.command('stop').catch(() => {});
  kucuk?.mpv.stop().catch(() => {});
  yukleniyor = false;
  videoPenceresi?.hide();
  ana.loadFile(path.join(__dirname, 'baslangic.html'));
});
app.on('window-all-closed', () => app.quit());
