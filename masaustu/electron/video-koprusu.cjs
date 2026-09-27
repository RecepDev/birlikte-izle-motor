// Oda sayfasındaki <video> öğesini mpv'ye bağlar.
//
// Sayfa (room.js, player.js, sync.js) standart bir <video> ile konuştuğunu sanır; burada o
// öğenin özellikleri ve yöntemleri mpv'ye yönlendirilir. Böylece sohbet, kalite listesi,
// altyazı sekmesi ve senkron kodu olduğu gibi çalışır - yalnızca görüntüyü tarayıcı yerine
// mpv çizer (gerçek HDR/Dolby Vision, tüm ses parçaları, donanım çözme).
const { ipcRenderer } = require('electron');

// mpv'den gelen son durum. Sayfa bunları senkron hesabında sürekli okur.
const durum = {
  position: 0,
  duration: null,
  paused: true,
  seeking: false,
  rate: 1,
  width: 0,
  height: 0,
  cacheEnd: 0,
  idle: true,
  cacheStalled: false,
  loaded: false,
};

let el = null;
const yolla = (tip) => el && el.dispatchEvent(new Event(tip));

// Yeni kaynak seçilince görüntü gelene kadar mpv siyah kalıyor. O sürede mpv
// penceresini gizleyip yerine "yükleniyor" göstergesi koyuyoruz.
let yukleniyor = false;
let yerlestir = () => {};
function yuklemeDurumu(deger) {
  if (yukleniyor === deger) return;
  yukleniyor = deger;
  if (deger) yerlestir(); // üstte satırlar açılıp kapanınca videonun yeri kayabiliyor
  el?.closest('.player')?.classList.toggle('mpv-yukleniyor', deger);
  ipcRenderer.send('kabuk:yukleniyor', deger);
}

// readyState: sayfa >=1 ile "medya var mı", >=3 ile "oynatılabilir mi" diye bakıyor.
function readyState() {
  if (!durum.loaded || durum.duration === null) return 0;
  if (durum.cacheStalled) return 2;
  return 4;
}

function zamanAraligi(end) {
  return {
    length: end > 0 ? 1 : 0,
    start: () => 0,
    end: () => end,
  };
}

// Sayfanın verdiği adres göreli olabilir (/relay/...); mpv mutlak adres ister.
const mutlak = (url) => (url ? new URL(url, location.href).href : '');

function bagla(video) {
  el = video;
  // Sayfa sesi köprü kurulmadan önce ayarlamış olabilir (kayıtlı ses düzeyi):
  // o değeri alıp mpv'ye de yolluyoruz, yoksa her açılışta %100'den başlıyordu.
  volume = Number.isFinite(video.volume) ? video.volume : 1;
  muted = Boolean(video.muted);
  ipcRenderer.send('mpv:ozellik', 'volume', Math.round(Math.cbrt(volume) * 100));
  ipcRenderer.send('mpv:ozellik', 'mute', muted);
  const tanim = (ad, get, set) => Object.defineProperty(video, ad, { configurable: true, get, set });

  tanim('currentTime', () => durum.position, (v) => ipcRenderer.send('mpv:sar', Number(v) || 0));
  tanim('duration', () => (durum.duration === null ? NaN : durum.duration));
  tanim('paused', () => durum.paused);
  tanim('seeking', () => durum.seeking);
  tanim('readyState', readyState);
  tanim('videoWidth', () => durum.width);
  tanim('videoHeight', () => durum.height);
  tanim('buffered', () => zamanAraligi(durum.cacheEnd));
  tanim('ended', () => false);
  tanim('playbackRate', () => durum.rate, (v) => ipcRenderer.send('mpv:ozellik', 'speed', Number(v) || 1));
  tanim('volume', () => volume, (v) => {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    // mpv'nin ses ayarı kübik (%50 = sesin sekizde biri); tarayıcınınki doğrusal.
    // Küpkökünü verince kaydırıcı tarayıcıdaki gibi davranıyor, %50 altında ses kaybolmuyor.
    ipcRenderer.send('mpv:ozellik', 'volume', Math.round(Math.cbrt(volume) * 100));
    yolla('volumechange');
  });
  tanim('muted', () => muted, (v) => {
    muted = Boolean(v);
    ipcRenderer.send('mpv:ozellik', 'mute', muted);
    yolla('volumechange');
  });
  // Sayfa kaynağı src ile veriyor; biz bunu mpv'ye yükletiyoruz.
  tanim('src', () => kaynak, (v) => {
    kaynak = String(v || '');
    yuklemeDurumu(Boolean(kaynak));
    ipcRenderer.send('mpv:yukle', mutlak(kaynak));
  });

  const yerTutucu = document.createElement('div');
  yerTutucu.className = 'mpv-yer-tutucu';
  yerTutucu.innerHTML = '<div class="mpv-donen"></div><span>Kaynak yükleniyor…</span>';
  video.after(yerTutucu);
  // Gösterge videonun kapladığı alanı birebir örter.
  yerlestir = () => Object.assign(yerTutucu.style, {
    left: `${video.offsetLeft}px`, top: `${video.offsetTop}px`,
    width: `${video.offsetWidth}px`, height: `${video.offsetHeight}px`,
  });
  new ResizeObserver(yerlestir).observe(video);
  yerlestir();

  video.play = () => {
    ipcRenderer.send('mpv:ozellik', 'pause', false);
    return Promise.resolve();
  };
  video.pause = () => ipcRenderer.send('mpv:ozellik', 'pause', true);
  video.load = () => {};
  video.removeAttribute = (ad) => {
    if (ad === 'src') {
      kaynak = '';
      yuklemeDurumu(false);
      ipcRenderer.send('mpv:durdur');
    }
  };
  // Görüntü ayarı (parlaklık/kontrast/renk) CSS filtresi yerine mpv'ye gider: 4K'da
  // tarayıcı filtresi kare kaybettiriyordu, mpv bunu bedavaya yapıyor.
  const stil = video.style;
  Object.defineProperty(video, 'style', {
    configurable: true,
    get: () => new Proxy(stil, {
      set(hedef, ad, deger) {
        if (ad === 'filter') {
          ipcRenderer.send('mpv:filtre', String(deger || ''));
          return true;
        }
        hedef[ad] = deger;
        return true;
      },
    }),
  });
}

let kaynak = '';
let volume = 1;
let muted = false;

// Altyazı köprüsü (subs.js buradaki kancayı arıyor). Sayfa altyazıyı kendi HTML
// katmanında çiziyordu; mpv'nin yerel penceresinin üstüne HTML gelemediği için
// altyazıyı mpv'ye veriyoruz. Metni burada okuyup gönderiyoruz: adres blob:
// (konuğun kendi dosyası) ya da göreli olabilir, mpv ikisini de açamaz.
let sonAltyazi = null;
window.masaustuAltyazi = {
  async uygula(url, offset) {
    ipcRenderer.send('mpv:altyazi-gecikme', Number(offset) || 0);
    const hedef = url ? mutlak(url) : null;
    if (hedef === sonAltyazi) return;
    sonAltyazi = hedef;
    if (!hedef) return ipcRenderer.send('mpv:altyazi-kapat');
    try {
      const metin = await (await fetch(hedef)).text();
      if (sonAltyazi === hedef) ipcRenderer.send('mpv:altyazi', metin);
    } catch {
      ipcRenderer.send('mpv:altyazi-kapat');
    }
  },
  stil(s) {
    ipcRenderer.send('mpv:altyazi-stil', s);
  },
};

// Ses parçaları: tarayıcı MKV'nin alternatif ses parçalarını hiç göremiyordu,
// mpv hepsini listeliyor. Etiketi sayfa üretiyor (dil adları orada).
let sesler = [];
ipcRenderer.on('mpv:sesler', (_e, liste) => {
  sesler = liste || [];
  // Olayla haber veriyoruz: bu betik sayfa betiklerinden sonra çalışıyor, o yüzden
  // sayfanın kurduğu bir geri çağırmaya güvenilemez.
  window.dispatchEvent(new Event('masaustu-sesler'));
});
// Ayar değişince kısa bilgi: HTML bildirim mpv'nin altında kalıyor, o yüzden
// yazıyı mpv kendi ekranında (alt ortada) gösteriyor.
window.masaustuBilgi = (metin) => ipcRenderer.send('mpv:bilgi', String(metin));

// Dosyanın içindeki (gömülü) altyazılar: mpv listeliyor, kişi seçerse mpv çiziyor.
let gomulu = [];
ipcRenderer.on('mpv:gomulu', (_e, liste) => {
  gomulu = liste || [];
  window.dispatchEvent(new Event('masaustu-gomulu'));
});
window.masaustuGomulu = {
  liste: () => gomulu,
  sec: (id) => ipcRenderer.send('mpv:gomulu-sec', String(id || '')),
};

// Kişisel ses gecikmesi (bluetooth kulaklıkta ses geride kalırsa), saniye.
let sonGecikme = null;
window.masaustuSesGecikme = (saniye) => {
  const deger = Number(saniye) || 0;
  if (deger === sonGecikme) return;
  sonGecikme = deger;
  ipcRenderer.send('mpv:ozellik', 'audio-delay', deger);
};

// ⋯ menüsü: VLC'de açma (bulunamazsa false) ve indirme (Electron'un kaydetme penceresi).
window.masaustuHarici = {
  vlc: (url, ad, saniye) => ipcRenderer.invoke('kabuk:vlc', String(url), String(ad || ''), Number(saniye) || 0),
  indir: (url) => ipcRenderer.send('kabuk:indir', String(url)),
};
// Çubuk önizlemesi: o saniyenin küçük resmi (data: adresi) ya da null.
window.masaustuOnizleme = (url, saniye) => ipcRenderer.invoke('kabuk:onizleme', String(url), Number(saniye) || 0);

// Host odayı kapattı: açılış ekranına dön (oynatma durur).
window.masaustuOdaKapandi = () => ipcRenderer.send('kabuk:baslangic');

// Tam ekranda gelen sohbet mesajı: videonun sol altında kısa süre görünür (mpv çiziyor).
window.masaustuSohbet = (kim, metin) => ipcRenderer.send('mpv:sohbet', String(kim || ''), String(metin || ''));

// Görüntü oranı düğmesi: sayfanın modlarını mpv özelliklerine çeviriyoruz.
let sonOran = null;
window.masaustuOran = (mod) => {
  if (mod === sonOran) return;
  sonOran = mod;
  ipcRenderer.send('mpv:oran', mod);
};

window.masaustuSes = {
  liste: () => sesler,
  sec: (id) => ipcRenderer.send('mpv:ses-sec', Number(id)),
};

ipcRenderer.on('mpv:durum', (_e, next) => {
  const oncekiDuraklat = durum.paused;
  const oncekiHazir = readyState();
  const oncekiSure = durum.duration;
  Object.assign(durum, next);
  if (!el) return;
  if (oncekiSure !== durum.duration) {
    // Süre değişince ikisi de gerekiyor: sayfa süreyi 'durationchange' ile okuyor,
    // hazır olmayı 'loadedmetadata' ile.
    yolla('durationchange');
    if (oncekiSure === null && durum.duration !== null) yolla('loadedmetadata');
  }
  if (oncekiHazir < 3 && readyState() >= 3) yolla('canplay');
  if (yukleniyor && readyState() >= 3 && durum.width > 0) yuklemeDurumu(false);
  else if (yukleniyor) yerlestir();
  if (oncekiDuraklat !== durum.paused) yolla(durum.paused ? 'pause' : 'play');
  if (durum.cacheStalled) yolla('waiting');
  yolla('timeupdate');
});
ipcRenderer.on('mpv:sarildi', () => yolla('seeked'));

// room.js #video'yu modül yüklenirken yakalıyor; aynı nesneyi yamadığımız için
// zamanlama önemli değil, yeter ki öğe DOM'a girmiş olsun.
function kur() {
  const video = document.getElementById('video');
  if (video) return bagla(video);
  new MutationObserver((_m, gozlemci) => {
    const v = document.getElementById('video');
    if (v) {
      gozlemci.disconnect();
      bagla(v);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', kur, { once: true });
else kur();
