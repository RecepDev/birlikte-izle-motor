// Oda sayfasındaki <video> öğesini ExoPlayer'a bağlar (telefon).
//
// Masaüstündeki video-koprusu.cjs'nin karşılığı; sayfa aynı kancaları kullanıyor:
// masaustuSes (ses parçaları, ayrıca "dönüştürme yapma" işareti), masaustuAltyazi,
// masaustuOran. Farkı: Android'de HTML videonun üstüne çizilebildiği için kontroller
// ve altyazı sayfada kalıyor; sayfanın video alanı saydam, video arkada oynuyor.
(() => {
  if (window.__kopru) return;
  const A = window.AndroidKopru;
  if (!A) return;

  const durum = {
    position: 0, duration: null, paused: true, seeking: false, rate: 1,
    width: 0, height: 0, cacheEnd: 0, idle: true, cacheStalled: false, loaded: false,
  };
  let el = null;
  let kaynak = '';
  let volume = 1;
  let muted = false;
  let hata = null;
  const yolla = (tip) => el && el.dispatchEvent(new Event(tip));
  const mutlak = (url) => (url ? new URL(url, location.href).href : '');

  function readyState() {
    if (!durum.loaded || durum.duration === null) return 0;
    return durum.cacheStalled ? 2 : 4;
  }

  // ---- yükleniyor göstergesi --------------------------------------------------------
  let yukleniyor = false;
  let yerTutucu = null;
  function yuklemeDurumu(deger) {
    if (yukleniyor === deger) return;
    yukleniyor = deger;
    el?.closest('.player')?.classList.toggle('mobil-yukleniyor', deger);
  }

  // ---- video alanı: oynatıcı bu dikdörtgene oturur ----------------------------------
  // <video>'nun değil oynatıcı kutusunun (.player) alanı: sayfa "Doldur" modunda videoyu
  // kutudan taşırıyor, taşan kısım sayfanın öteki bölümlerinin arkasında görünürdü.
  // Kırpmayı/sığdırmayı ExoPlayer'ın kendisi yapıyor (masaustuOran).
  let bekleyen = false;
  let son = '';
  function alanBildir() {
    if (bekleyen || !el) return;
    bekleyen = true;
    requestAnimationFrame(() => {
      bekleyen = false;
      const r = (el.closest('.player') || el).getBoundingClientRect();
      const olcu = `${Math.round(r.x)}|${Math.round(r.y)}|${Math.round(r.width)}|${Math.round(r.height)}`;
      if (olcu === son) return;
      son = olcu;
      A.alan(r.x, r.y, r.width, r.height);
    });
  }

  function bagla(video) {
    el = video;
    volume = Number.isFinite(video.volume) ? video.volume : 1;
    muted = Boolean(video.muted);
    A.ses(muted ? 0 : volume);
    const tanim = (ad, get, set) => Object.defineProperty(video, ad, { configurable: true, get, set });

    tanim('currentTime', () => durum.position, (v) => A.sar(Number(v) || 0));
    tanim('duration', () => (durum.duration === null ? NaN : durum.duration));
    tanim('paused', () => durum.paused);
    tanim('seeking', () => durum.seeking);
    tanim('readyState', readyState);
    tanim('videoWidth', () => durum.width);
    tanim('videoHeight', () => durum.height);
    tanim('buffered', () => ({ length: durum.cacheEnd > 0 ? 1 : 0, start: () => 0, end: () => durum.cacheEnd }));
    tanim('ended', () => false);
    tanim('error', () => hata);
    tanim('playbackRate', () => durum.rate, (v) => A.hiz(Number(v) || 1));
    tanim('volume', () => volume, (v) => {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      A.ses(muted ? 0 : volume);
    });
    tanim('muted', () => muted, (v) => {
      muted = Boolean(v);
      A.ses(muted ? 0 : volume);
    });
    tanim('src', () => kaynak, (v) => {
      kaynak = String(v || '');
      hata = null;
      yuklemeDurumu(Boolean(kaynak));
      A.yukle(mutlak(kaynak));
    });
    // Sayfa oynatmadan önce "bu biçimi açabilir miyim" diye soruyor (codecs.js). WebView
    // HEVC/AC3'e çoğu telefonda "hayır" diyor ve sayfa dosyayı hiç vermeden "açılamaz"
    // sayıyordu. Oynatan ExoPlayer; telefonun donanımıyla açıyor, açamazsa hata bildiriyor.
    video.canPlayType = () => 'probably';
    // Kapak resmi de çizilmesin (varsayılan gri oynat simgesi).
    video.setAttribute('poster', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    video.play = () => {
      A.oynat(true);
      return Promise.resolve();
    };
    video.pause = () => A.oynat(false);
    video.load = () => {};
    const eskiKaldir = video.removeAttribute.bind(video);
    video.removeAttribute = (ad) => {
      if (ad === 'src') {
        kaynak = '';
        yuklemeDurumu(false);
        A.durdur();
        return;
      }
      eskiKaldir(ad);
    };

    yerTutucu = document.createElement('div');
    yerTutucu.className = 'mobil-yer-tutucu';
    yerTutucu.innerHTML = '<div class="mobil-donen"></div><span>Kaynak yükleniyor…</span>';
    video.after(yerTutucu);

    new ResizeObserver(alanBildir).observe(video.closest('.player') || video);
    window.addEventListener('scroll', alanBildir, true);
    window.addEventListener('resize', alanBildir);
    alanBildir();

    // Köprü kurulmadan sayfa kaynak vermiş olabilir (sayfa yenilenince).
    const onceki = video.getAttribute('src');
    if (onceki) video.src = onceki;
  }

  // ---- ExoPlayer'dan gelenler ----------------------------------------------------------
  window.__kopru = {
    durum(next) {
      const oncekiDuraklat = durum.paused;
      const oncekiHazir = readyState();
      const oncekiSure = durum.duration;
      Object.assign(durum, next);
      if (!el) return;
      if (oncekiSure !== durum.duration) {
        yolla('durationchange');
        if (oncekiSure === null && durum.duration !== null) yolla('loadedmetadata');
      }
      if (oncekiHazir < 3 && readyState() >= 3) yolla('canplay');
      if (yukleniyor && readyState() >= 3 && durum.width > 0) yuklemeDurumu(false);
      if (oncekiDuraklat !== durum.paused) yolla(durum.paused ? 'pause' : 'play');
      if (durum.cacheStalled) yolla('waiting');
      yolla('timeupdate');
      altyaziCiz();
      alanBildir();
    },
    sarildi() {
      yolla('seeked');
    },
    sesler(liste) {
      sesler = liste || [];
      window.dispatchEvent(new Event('masaustu-sesler'));
    },
    hata(kod) {
      hata = { code: 4, message: kod };
      yuklemeDurumu(false);
      yolla('error');
    },
    tamEkranCik() {
      if (tamEl) document.exitFullscreen();
    },
  };

  // ---- ses parçaları ---------------------------------------------------------------
  let sesler = [];
  window.masaustuSes = {
    liste: () => sesler,
    sec: (id) => A.sesSec(String(id)),
  };

  // ---- görüntü oranı ---------------------------------------------------------------
  let sonOran = null;
  window.masaustuOran = (mod) => {
    if (mod === sonOran) return;
    sonOran = mod;
    A.oran(String(mod));
  };

  // ---- altyazı: sayfanın kendi katmanına biz çiziyoruz ---------------------------
  // Sayfa ipuçlarını <track> ile okuyor ama o, gerçek bir medya zamanı olmadan hiç
  // tetiklenmiyor. Metni kendimiz ayrıştırıp oynatma konumuna göre çiziyoruz; stil,
  // boyut ve konum ayarları sayfanın katmanında olduğu için olduğu gibi çalışıyor.
  let ipuclari = [];
  let kayma = 0;
  let sonAltyazi = null;
  let sonCizilen = '';
  const zaman = (t) => {
    const p = t.trim().replace(',', '.').split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  function vttAyristir(metin) {
    const sonuc = [];
    for (const blok of metin.replace(/\r/g, '').split(/\n\n+/)) {
      const satirlar = blok.split('\n');
      const i = satirlar.findIndex((s) => s.includes('-->'));
      if (i < 0) continue;
      const [bas, bit] = satirlar[i].split('-->');
      const yazi = satirlar.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (yazi) sonuc.push({ bas: zaman(bas), bit: zaman(bit.trim().split(/\s+/)[0]), yazi });
    }
    return sonuc;
  }
  function altyaziCiz() {
    const katman = document.querySelector('.sub-overlay');
    if (!katman) return;
    const t = durum.position - kayma;
    const aktif = ipuclari.filter((c) => t >= c.bas && t <= c.bit).map((c) => c.yazi);
    const anahtar = aktif.join('\u0000');
    // Sayfa katmanı zaman zaman kendisi boşaltıyor; boşsa yeniden çiz.
    if (anahtar === sonCizilen && katman.childElementCount === aktif.length) return;
    sonCizilen = anahtar;
    katman.replaceChildren(...aktif.map((yazi) => {
      const s = document.createElement('span');
      s.className = 'sub-line';
      s.textContent = yazi;
      return s;
    }));
  }
  window.masaustuAltyazi = {
    async uygula(url, offset) {
      kayma = Number(offset) || 0;
      const hedef = url ? mutlak(url) : null;
      if (hedef !== sonAltyazi) {
        sonAltyazi = hedef;
        ipuclari = [];
        if (hedef) {
          try {
            const metin = await (await fetch(hedef)).text();
            if (sonAltyazi === hedef) ipuclari = vttAyristir(metin);
          } catch { /* sayfa zaten "yüklenemedi" diyor */ }
        }
      }
      sonCizilen = null;
      altyaziCiz();
    },
    stil() {}, // stil sayfanın katmanında, ayrıca bir şey gerekmiyor
  };

  // ---- tam ekran -----------------------------------------------------------------
  // WebView'de öğe tam ekranı güvenilir değil; taklit ediyoruz: oynatıcı sayfayı
  // kaplıyor, telefon yatay çevriliyor ve sistem çubukları gizleniyor.
  let tamEl = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => tamEl });
  const tamDegisti = () => {
    document.documentElement.classList.toggle('mobil-tam', Boolean(tamEl));
    document.dispatchEvent(new Event('fullscreenchange'));
    son = '';
    setTimeout(alanBildir, 300);
  };
  Element.prototype.requestFullscreen = function requestFullscreen() {
    tamEl = this;
    this.classList.add('mobil-tam-oge');
    A.tamEkran(true);
    tamDegisti();
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    tamEl?.classList.remove('mobil-tam-oge');
    tamEl = null;
    A.tamEkran(false);
    tamDegisti();
    return Promise.resolve();
  };

  // ---- görünüm -----------------------------------------------------------------
  const STIL = `
    html, body { background: transparent !important; }
    .player, .player video { background: transparent !important; }
    /* Android WebView boş <video> için gri zeminli büyük bir oynat simgesi çiziyor ve
       arkadaki ExoPlayer görüntüsünü örtüyordu (ses/altyazı gelip görüntü gelmiyordu).
       Öğe yerinde kalsın (ölçü için) ama hiç çizilmesin. */
    .player video { opacity: 0 !important; }
    #open-desktop, #open-compat, #btn-compat, .compat-popover { display: none !important; }
    .mobil-tam-oge {
      position: fixed !important; inset: 0 !important; z-index: 1000 !important;
      width: 100vw !important; height: 100vh !important; border-radius: 0 !important;
    }
    /* Oynatıcı saydam; tam ekranda arkasında kalan sayfa (sohbet vb.) videonun
       üstünde görünmesin diye gizleniyor. */
    html.mobil-tam body * { visibility: hidden !important; }
    html.mobil-tam .mobil-tam-oge, html.mobil-tam .mobil-tam-oge * { visibility: visible !important; }
    html.mobil-tam .mobil-tam-oge [hidden] { visibility: hidden !important; }
    .mobil-yer-tutucu { display: none; }
    .player.mobil-yukleniyor .mobil-yer-tutucu {
      position: absolute; inset: 0; z-index: 2; background: #000; color: #9096a6; font-size: 15px;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    }
    .mobil-donen {
      width: 38px; height: 38px; border-radius: 50%;
      border: 4px solid #2a2e39; border-top-color: #7b5cff; animation: mobil-don .9s linear infinite;
    }
    @keyframes mobil-don { to { transform: rotate(360deg); } }
  `;
  function stilEkle() {
    const s = document.createElement('style');
    s.textContent = STIL;
    (document.head || document.documentElement).appendChild(s);
  }

  function kur() {
    if (!document.getElementById('video')) return false;
    stilEkle();
    bagla(document.getElementById('video'));
    return true;
  }
  // Belge başında çalışıyorsak <video> henüz yok: gelince bağlanıyoruz.
  if (!kur()) {
    new MutationObserver((_m, gozlemci) => {
      if (kur()) gozlemci.disconnect();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
