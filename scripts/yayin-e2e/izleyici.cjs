// IZLEYICI: siradan bir tarayici gibi oda sayfasini acar (masaustu kabugu yok), odaya girer,
// "Yayini izle"ye basar ve gelen yayini olcer: kare hizi, cozunurluk, ses seviyesi, kendi
// oynaticisinin durmasi. Ses HOPARLORE VERILMEZ (ayni bilgisayarda host'un sistem sesi yakalamasi
// onu tekrar yakalar, yanki dongusu olur): ses dogrudan akistan olculur.
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { bekle, kosulBekle, katil, yaz, gorunmezlikKapat } = require('./ortak.cjs');

app.setPath('userData', path.join(os.tmpdir(), `birlikte-izle-yayin-testi-izleyici-${process.pid}`));
gorunmezlikKapat(app);
const SONUC = process.env.SONUC_IZLEYICI;
const ODA = process.env.ODA_IZLEYICI;

app.whenReady().then(async () => {
  const sonuc = { adimlar: [] };
  const not = (x) => { sonuc.adimlar.push(x); yaz(SONUC, sonuc); };
  const win = new BrowserWindow({ x: 700, y: 60, width: 960, height: 640, title: 'Izleyici (test)', webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadURL(ODA);
  const wc = win.webContents;
  // Masaüstü uygulamasının stilleri de olsun: yayın videosunu gizleyen kural orada yakalanır.
  await wc.insertCSS(require('node:fs').readFileSync(path.join(__dirname, '..', '..', 'masaustu', 'electron', 'masaustu.css'), 'utf8'));
  not(await katil(wc, 'TestIzleyici') ? 'odaya girdi' : 'ODAYA GIREMEDI');
  not(await kosulBekle(wc, "!document.querySelector('#yayin-izle').hidden", 60000) ? 'Yayini izle dugmesi gorundu' : 'YAYIN DUGMESI GORUNMEDI');
  // Yayın açıkken girildiyse doğrudan yayına girmiş olmalı (kendi kaynağı açılmadan).
  const dogrudan = await wc.executeJavaScript("!document.querySelector('#yayin-katman').hidden");
  if (dogrudan) not('yayin acikken girince dogrudan yayina girdi');
  else await wc.executeJavaScript("document.querySelector('#yayin-izle').click()");
  not(await kosulBekle(wc, "document.querySelector('#yayin-video').videoWidth > 0", 25000) ? 'yayin goruntusu geldi' : 'YAYIN GORUNTUSU GELMEDI');
  await bekle(6000); // bit hizi otursun
  const olcum = await wc.executeJavaScript(`new Promise((sonuc) => {
    const v = document.querySelector('#yayin-video');
    const akis = v.srcObject;
    const kareler = [];
    const t0 = performance.now();
    let ses = null;
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(akis).connect(an);
      const buf = new Float32Array(an.fftSize);
      let enYuksek = 0;
      const sesOlc = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let t = 0; for (const x of buf) t += x * x;
        enYuksek = Math.max(enYuksek, Math.sqrt(t / buf.length));
      }, 200);
      ses = () => { clearInterval(sesOlc); return enYuksek; };
    } catch (e) { ses = () => 'HATA ' + e; }
    const her = (now, meta) => {
      kareler.push(meta.mediaTime);
      if (now - t0 < 10000) v.requestVideoFrameCallback(her);
      else {
        const aralik = kareler.slice(1).map((t, i) => (t - kareler[i]) * 1000).sort((a, b) => a - b);
        const rms = ses();
        sonuc({
          cozunurluk: v.videoWidth + 'x' + v.videoHeight,
          fps: +((kareler.length - 1) / (kareler.at(-1) - kareler[0])).toFixed(1),
          aralik_ms_orta: +(aralik[Math.floor(aralik.length / 2)] || 0).toFixed(1),
          aralik_ms_en_uzun: +(aralik.at(-1) || 0).toFixed(1),
          ses_izi: akis.getAudioTracks().length,
          ses_seviyesi_dBFS: typeof rms === 'number' ? (rms > 0 ? +(20 * Math.log10(rms)).toFixed(1) : -999) : rms,
          kendi_oynatici_src: document.querySelector('#video').getAttribute('src'),
          kendi_oynatici: (() => { const x = document.querySelector('#video'); return 'currentSrc=' + (x.currentSrc || '-') + ' network=' + x.networkState + ' ready=' + x.readyState + ' paused=' + x.paused + ' buffered=' + (x.buffered.length ? x.buffered.end(0).toFixed(1) : 0); })(),
          katman_acik: !document.querySelector('#yayin-katman').hidden,
          // Görüntü siyah mı? Karenin ortalama parlaklığı (0-255) ve renk çeşitliliği.
          parlaklik: (() => {
            const c = document.createElement('canvas');
            c.width = 160; c.height = 90;
            const g = c.getContext('2d');
            g.drawImage(v, 0, 0, c.width, c.height);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            let t = 0; let enCok = 0;
            for (let i = 0; i < d.length; i += 4) { const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; t += y; enCok = Math.max(enCok, y); }
            return { ortalama: Math.round(t / (d.length / 4)), en_parlak: Math.round(enCok) };
          })(),
          bilgi: document.querySelector('#yayin-bilgi').textContent,
          bekleme_afisi: document.querySelector('#banner').hidden ? null : document.querySelector('#banner-text').textContent,
        });
      }
    };
    v.requestVideoFrameCallback(her);
  })`);
  sonuc.olcum = olcum;
  yaz(SONUC, sonuc);
  // Yayının kendi çubuğu: ses kaydırıcısı ve tam ekran
  const ses = await wc.executeJavaScript(`(() => { const r = document.querySelector('#yayin-ses'); r.value = '0.3'; r.dispatchEvent(new Event('input')); return document.querySelector('#yayin-video').volume; })()`);
  not(Math.abs(ses - 0.3) < 0.01 ? 'yayin ses kaydiricisi calisiyor' : `YAYIN SES KAYDIRICISI CALISMIYOR (${ses})`);
  // Görüntü oranı: Doldur'a geçince video kutuyu kaplasın
  const oranlar = await wc.executeJavaScript(`(() => { const b = document.querySelector('#yayin-oran'); const once = b.textContent; b.click(); return [once, b.textContent, getComputedStyle(document.querySelector('#yayin-video')).objectFit]; })()`);
  not(oranlar[2] === 'cover' ? `yayin orani degisti (${oranlar[0]} -> ${oranlar[1]})` : `YAYIN ORANI DEGISMEDI (${oranlar.join(' ')})`);
  // İzleyiciler listesinde "yayını izliyor" ve verileri (kendi satırı)
  await bekle(2500);
  const satir = await wc.executeJavaScript("[...document.querySelectorAll('#user-list li')].map((li) => li.textContent).find((t) => t.includes('TestIzleyici')) || ''");
  not(/yayını izliyor/.test(satir) ? `izleyiciler listesinde: ${satir.replace(/\s+/g, ' ').slice(0, 90)}` : `IZLEYICILER LISTESINDE YAYIN YOK (${satir.slice(0, 80)})`);
  await wc.executeJavaScript("document.querySelector('#yayin-tam').click()", true);
  not(await kosulBekle(wc, 'Boolean(document.fullscreenElement)', 5000) ? 'yayin tam ekran oldu' : 'YAYIN TAM EKRAN OLMADI');
  await wc.executeJavaScript('document.exitFullscreen()').catch(() => {});
  await bekle(800);
  // Host yayın sürerken 480p'ye düşürüyor: görüntü küçülmeli (bağlantı yenilenir)
  not(await kosulBekle(wc, "document.querySelector('#yayin-video').videoHeight > 0 && document.querySelector('#yayin-video').videoHeight <= 480", 40000)
    ? `ayar degisince goruntu kuculdu (${await wc.executeJavaScript("document.querySelector('#yayin-video').videoWidth + 'x' + document.querySelector('#yayin-video').videoHeight")})`
    : 'AYAR DEGISINCE GORUNTU KUCULMEDI');
  // Yayindan cik: kendi oynaticisi geri gelmeli
  await wc.executeJavaScript("document.querySelector('#yayin-cik').click()");
  not(await kosulBekle(wc, "document.querySelector('#yayin-katman').hidden && Boolean(document.querySelector('#video').currentSrc)", 15000)
    ? 'yayindan cikinca kendi oynaticisi geri geldi' : 'YAYINDAN CIKINCA OYNATICI GERI GELMEDI');
  app.exit(0);
});
