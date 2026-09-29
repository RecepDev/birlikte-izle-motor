// IZLEYICI: siradan bir tarayici gibi oda sayfasini acar (masaustu kabugu yok), odaya girer,
// "Yayini izle"ye basar ve gelen yayini olcer: kare hizi, cozunurluk, ses seviyesi, kendi
// oynaticisinin durmasi. Ses HOPARLORE VERILMEZ (ayni bilgisayarda host'un sistem sesi yakalamasi
// onu tekrar yakalar, yanki dongusu olur): ses dogrudan akistan olculur.
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { bekle, kosulBekle, katil, yaz } = require('./ortak.cjs');

app.setPath('userData', path.join(os.tmpdir(), `birlikte-izle-yayin-testi-izleyici-${process.pid}`));
const SONUC = process.env.SONUC_IZLEYICI;
const ODA = process.env.ODA_IZLEYICI;

app.whenReady().then(async () => {
  const sonuc = { adimlar: [] };
  const not = (x) => { sonuc.adimlar.push(x); yaz(SONUC, sonuc); };
  const win = new BrowserWindow({ x: 700, y: 60, width: 960, height: 640, title: 'Izleyici (test)', webPreferences: { backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  await win.loadURL(ODA);
  const wc = win.webContents;
  not(await katil(wc, 'TestIzleyici') ? 'odaya girdi' : 'ODAYA GIREMEDI');
  not(await kosulBekle(wc, "!document.querySelector('#yayin-izle').hidden", 60000) ? 'Yayini izle dugmesi gorundu' : 'YAYIN DUGMESI GORUNMEDI');
  await wc.executeJavaScript("document.querySelector('#yayin-izle').click()");
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
          bilgi: document.querySelector('#yayin-bilgi').textContent,
          bekleme_afisi: document.querySelector('#banner').hidden ? null : document.querySelector('#banner-text').textContent,
        });
      }
    };
    v.requestVideoFrameCallback(her);
  })`);
  sonuc.olcum = olcum;
  yaz(SONUC, sonuc);
  // Yayindan cik: kendi oynaticisi geri gelmeli
  await wc.executeJavaScript("document.querySelector('#yayin-cik').click()");
  not(await kosulBekle(wc, "document.querySelector('#yayin-katman').hidden && Boolean(document.querySelector('#video').currentSrc)", 15000)
    ? 'yayindan cikinca kendi oynaticisi geri geldi' : 'YAYINDAN CIKINCA OYNATICI GERI GELMEDI');
  app.exit(0);
});
