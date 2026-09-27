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
  // Sarma sürüyor: ExoPlayer yeni yere yeterince indirene (READY) kadar "hazır değil" ve
  // "sarılıyor" bildiriliyor; oda telefonu bekliyor. ExoPlayer seek anında "sarıldı" diyordu,
  // sayfa telefonu hemen hazır sayıyor ve oda beklemeden devam ediyordu.
  let sarma = null;
  // Konum ExoPlayer'dan 0,2 sn'de bir geliyor: aradaki zamanı tahmin et (oynuyorsa geçen süre
  // kadar ileri). Yoksa senkron her okumada 0-0,2 sn titreyen bir sapma görüp hızı boşuna
  // değiştiriyordu.
  let durumZamani = 0;
  function konumTahmini() {
    if (durum.paused || durum.seeking || durum.cacheStalled || !durumZamani) return durum.position;
    return durum.position + Math.min(0.5, (Date.now() - durumZamani) / 1000) * (durum.rate || 1);
  }
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

    tanim('currentTime', konumTahmini, (v) => {
      const hedef = Number(v) || 0;
      sarma = { hedef, at: Date.now() };
      Object.assign(durum, { position: hedef, seeking: true, cacheStalled: true });
      A.sar(hedef);
      yolla('seeking');
      yolla('waiting');
      yolla('timeupdate');
    });
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
      yolla('volumechange');
    });
    tanim('muted', () => muted, (v) => {
      muted = Boolean(v);
      A.ses(muted ? 0 : volume);
      yolla('volumechange');
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
    if (video.closest('.player')) hareketKur(video.closest('.player'));
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
      let sarmaBitti = false;
      if (sarma) {
        // İlk ~0,5 sn gelen durum sarmadan önceki olabilir (eski yer, READY): yok say.
        const taze = Date.now() - sarma.at > 300;
        if (!taze) next = { ...next, position: sarma.hedef };
        if (!taze || next.cacheStalled) next = { ...next, seeking: true, cacheStalled: true };
        else {
          sarma = null;
          sarmaBitti = true;
        }
      }
      Object.assign(durum, next);
      durumZamani = Date.now();
      if (!el) return;
      if (oncekiSure !== durum.duration) {
        yolla('durationchange');
        if (oncekiSure === null && durum.duration !== null) yolla('loadedmetadata');
      }
      if (oncekiHazir < 3 && readyState() >= 3) yolla('canplay');
      if (yukleniyor && readyState() >= 3 && durum.width > 0) yuklemeDurumu(false);
      if (oncekiDuraklat !== durum.paused) yolla(durum.paused ? 'pause' : 'play');
      if (durum.cacheStalled) yolla('waiting');
      if (sarmaBitti) yolla('seeked');
      yolla('timeupdate');
      altyaziCiz();
      alanBildir();
    },
    // "seeked" artık yeni yer hazır olunca durum()'dan gidiyor.
    sarildi() {},
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
    // Telefon bu sesi çözemiyor (ör. DTS): sayfa yalnızca sesi dönüştüren moda geçer.
    sesDesteklenmiyor() {
      window.dispatchEvent(new Event('masaustu-ses-yok'));
    },
    gomuluAltyazilar(liste) {
      gomulu = liste || [];
      window.dispatchEvent(new Event('masaustu-gomulu'));
    },
    // Resim içinde resimden dönünce oynatıcıyı yeniden yerine koy.
    yenidenOlc() {
      son = '';
      alanBildir();
    },
  };

  // ---- gömülü altyazılar (dosyanın içindekiler) -----------------------------------
  let gomulu = [];
  window.masaustuGomulu = {
    liste: () => gomulu,
    sec: (id) => A.gomuluSec(String(id || '')),
  };

  // ---- dokunmatik hareketler -------------------------------------------------------
  // Sol yarıda yukarı/aşağı kaydırma parlaklık, sağ yarıda ses. Çift dokunuş sağda
  // 10 sn ileri, solda geri - sayfanın kendi sarma çubuğu üzerinden, yani host kilidi
  // açıksa misafirde çalışmaz (sayfa izin vermez).
  let parlaklik = 0.5;
  function hareketKur(oyuncu) {
    let bas = null;
    let sonDokunus = 0;
    oyuncu.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('.controls, button, input')) return;
      const t = e.touches[0];
      const r = oyuncu.getBoundingClientRect();
      bas = { x: t.clientX, y: t.clientY, sol: t.clientX < r.left + r.width / 2, deger: null, yukseklik: r.height };
    }, { passive: true });
    oyuncu.addEventListener('touchmove', (e) => {
      if (!bas) return;
      const t = e.touches[0];
      const dy = bas.y - t.clientY;
      if (bas.deger === null) {
        // Yatay kaydırmayı (sayfa kaydırma vb.) karıştırmamak için önce dikey olduğundan emin ol.
        if (Math.abs(dy) < 18 || Math.abs(dy) < Math.abs(t.clientX - bas.x)) return;
        bas.deger = bas.sol ? parlaklik : (el?.volume ?? 1);
      }
      e.preventDefault();
      const yeni = Math.max(0, Math.min(1, bas.deger + dy / (bas.yukseklik * 0.8)));
      if (bas.sol) {
        parlaklik = yeni;
        A.parlaklik(yeni);
      } else {
        const kaydirici = document.getElementById('volume');
        if (kaydirici) {
          kaydirici.value = String(yeni);
          kaydirici.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      ipucu(bas.sol ? `☀️ %${Math.round(yeni * 100)}` : `🔊 %${Math.round(yeni * 100)}`);
    }, { passive: false });
    oyuncu.addEventListener('touchend', (e) => {
      const kaydirildi = bas?.deger !== null && bas?.deger !== undefined;
      const sol = bas?.sol;
      bas = null;
      if (kaydirildi || e.target.closest('.controls, button, input')) return;
      const simdi = Date.now();
      if (simdi - sonDokunus < 300) {
        sonDokunus = 0;
        const cubuk = document.getElementById('seek');
        if (cubuk && !cubuk.disabled) {
          const hedef = Math.max(0, Math.min(Number(cubuk.max) || 0, durum.position + (sol ? -10 : 10)));
          cubuk.value = String(hedef);
          cubuk.dispatchEvent(new Event('input', { bubbles: true }));
          cubuk.dispatchEvent(new Event('change', { bubbles: true }));
          ipucu(sol ? '⏪ 10 sn' : '10 sn ⏩');
        }
      } else {
        sonDokunus = simdi;
      }
    });
  }

  // ---- ses düğmesi: dokununca yukarı doğru dikey kaydırıcı açılır ------------------
  // Dar ekranda sayfa ses kaydırıcısını gizliyor, 🔊 yalnızca sessize alıyordu.
  // Sayfanın kendi #volume kaydırıcısını açılır kutuya taşıyoruz (dinleyicileri onda).
  let sesKutusu = null;
  function sesKutusuKur() {
    const kaydirici = document.getElementById('volume');
    const oyuncu = el?.closest('.player');
    if (!kaydirici || !oyuncu) return null;
    const kutu = document.createElement('div');
    kutu.className = 'mobil-ses-kutu';
    kutu.hidden = true;
    const sessiz = document.createElement('button');
    sessiz.type = 'button';
    sessiz.className = 'mobil-ses-sessiz';
    const yaz = () => { sessiz.textContent = muted || volume === 0 ? '🔇' : volume < 0.34 ? '🔈' : volume < 0.67 ? '🔉' : '🔊'; };
    sessiz.addEventListener('click', (e) => {
      e.stopPropagation();
      el.muted = !muted;
      yaz();
    });
    kaydirici.addEventListener('input', yaz);
    kutu.append(kaydirici, sessiz);
    oyuncu.appendChild(kutu);
    yaz();
    // Kutunun dışına dokununca kapansın.
    document.addEventListener('pointerdown', (e) => {
      if (!kutu.hidden && !e.target.closest('.mobil-ses-kutu, #btn-mute')) kutu.hidden = true;
    }, true);
    return kutu;
  }
  document.addEventListener('click', (e) => {
    const dugme = e.target.closest('#btn-mute');
    if (!dugme) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    sesKutusu ||= sesKutusuKur();
    if (!sesKutusu) return;
    const oyuncu = el.closest('.player').getBoundingClientRect();
    const r = dugme.getBoundingClientRect();
    sesKutusu.style.left = `${r.left - oyuncu.left + r.width / 2}px`;
    sesKutusu.style.bottom = `${oyuncu.bottom - r.top + 6}px`;
    sesKutusu.hidden = !sesKutusu.hidden;
  }, true);

  // Tam ekranda gelen sohbet mesajları videonun sol altında, 8 sn.
  window.masaustuSohbet = (kim, metin) => {
    const oyuncu = el?.closest('.player');
    if (!oyuncu) return;
    let kutu = oyuncu.querySelector('.mobil-sohbet');
    if (!kutu) {
      kutu = document.createElement('div');
      kutu.className = 'mobil-sohbet';
      oyuncu.appendChild(kutu);
    }
    const satir = document.createElement('div');
    const ad = document.createElement('b');
    ad.textContent = `${kim}: `;
    satir.append(ad, document.createTextNode(metin));
    kutu.appendChild(satir);
    while (kutu.childElementCount > 4) kutu.firstElementChild.remove();
    setTimeout(() => satir.remove(), 8000);
  };

  // Hareketlerin kısa göstergesi: oynatıcının ortasında.
  let ipucuEl = null;
  let ipucuZaman = null;
  function ipucu(metin) {
    const oyuncu = el?.closest('.player');
    if (!oyuncu) return;
    if (!ipucuEl) {
      ipucuEl = document.createElement('div');
      ipucuEl.className = 'mobil-ipucu';
      oyuncu.appendChild(ipucuEl);
    }
    ipucuEl.textContent = metin;
    ipucuEl.hidden = false;
    clearTimeout(ipucuZaman);
    ipucuZaman = setTimeout(() => { ipucuEl.hidden = true; }, 900);
  }

  // Host odayı kapattı: açılış ekranına dön.
  window.masaustuOdaKapandi = () => A.odaKapandi?.();
  // Odada seçilen kalite tercihi uygulamanın kaydına da yazılsın (APK 0.14 ve sonrası).
  if (A.kaliteYaz) window.mobilKaliteYaz = (q) => A.kaliteYaz(String(q));
  // ⋯ menüsü: VLC'de aç / indir (APK 0.10 ve sonrası). Eski APK'da sayfanın kendi yolu kalır.
  if (A.harici) {
    window.masaustuHarici = {
      vlc: (url, ad) => { A.harici(String(url), 'vlc', String(ad || '')); return Promise.resolve(true); },
      indir: (url, ad) => A.harici(String(url), 'indir', String(ad || '')),
    };
  }

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
    .mobil-ipucu {
      position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 5;
      background: rgba(0, 0, 0, .65); color: #fff; padding: 8px 14px; border-radius: 10px;
      font-size: 16px; pointer-events: none;
    }
    .mobil-ipucu[hidden] { display: none; }
    .mobil-ses-kutu {
      position: absolute; z-index: 20; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      background: rgba(20, 22, 29, .92); border: 1px solid #2a2e39; border-radius: 10px; padding: 6px 2px 2px;
    }
    .mobil-ses-kutu[hidden] { display: none !important; }
    .mobil-ses-kutu .volume {
      display: block !important; width: 22px !important; height: 72px; margin: 0;
      writing-mode: vertical-lr; direction: rtl; accent-color: #7b5cff;
    }
    .mobil-ses-sessiz { background: none; border: 0; font-size: 13px; padding: 0 2px; line-height: 1.4; }
    .mobil-sohbet {
      position: absolute; left: 12px; bottom: 64px; z-index: 5; max-width: 70%;
      display: flex; flex-direction: column; gap: 4px; pointer-events: none;
    }
    .mobil-sohbet div {
      background: rgba(0, 0, 0, .6); color: #fff; padding: 4px 10px; border-radius: 8px; font-size: 14px;
    }
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
