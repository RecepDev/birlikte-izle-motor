// HOST: gercek Birlikte Izle masaustu istemcisini (kabuk + mpv + yayin yakalama kodu) GECICI bir
// kullanici klasoruyle calistirir - kullanicinin acik istemcisinin tek ornek kilidine ve ayarlarina
// dokunmaz. Oda adresi ODA_URL, mpv MPV_YOLU ile gelir. Yayini baslatir, 2 sn'de bir durumu yazar.
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const { bekle, kosulBekle, katil, yaz, gorunmezlikKapat } = require('./ortak.cjs');

const kullanici = path.join(os.tmpdir(), `birlikte-izle-yayin-testi-host-${process.pid}`);
app.setPath('userData', kullanici);
gorunmezlikKapat(app);
// ilk acilistaki 'Hangi goruntu kalitesini tercih edersin?' penceresi cikmasin (acik diyalog mpv'yi gizliyor)
require('node:fs').mkdirSync(kullanici, { recursive: true });
require('node:fs').writeFileSync(path.join(kullanici, 'ayar.json'), JSON.stringify({ kalite: '1080p' }));
const SONUC = process.env.SONUC_HOST;
const kalite = process.env.KALITE || '1080p30';
const sure = Number(process.env.SURE_MS || 60000);

require(path.join(__dirname, '..', '..', 'masaustu', 'electron', 'baslat.cjs'));
const ipcKayit = [];
const { ipcMain } = require('electron');
for (const k of ['kabuk:yukleniyor', 'kabuk:ortu']) ipcMain.on(k, (_e, v) => ipcKayit.push(`+${((Date.now() / 1000) % 1000).toFixed(1)} ${k}=${JSON.stringify(v)}`));

app.whenReady().then(async () => {
  const sonuc = { adimlar: [], durumlar: [] };
  const not = (x) => { sonuc.adimlar.push(x); yaz(SONUC, sonuc); };
  await bekle(1500);
  const ana = BrowserWindow.getAllWindows().find((w) => !w.getParentWindow());
  if (!ana) { not('ana pencere yok'); app.exit(2); return; }
  const wc = ana.webContents;
  sonuc.konsol = [];
  wc.on('console-message', (_e, seviye, mesaj) => { if (seviye >= 2 || /yayin|Yayın|getDisplayMedia|RTC/i.test(mesaj)) { sonuc.konsol.push(mesaj.slice(0, 300)); yaz(SONUC, sonuc); } });
  not(await katil(wc, 'TestHost') ? 'odaya girdi' : 'ODAYA GIREMEDI');
  not(await kosulBekle(wc, "!document.querySelector('#yayin-ac').hidden", 15000) ? 'Yayin Ac dugmesi gorunur (host)' : 'YAYIN AC DUGMESI YOK');
  // mpv oynamaya baslasin (yakalanacak goruntu)
  // Kullanıcı gibi odanın oynat düğmesiyle (video.play() doğrudan oynatıcıya gidiyor, oda
  // duraklatılmış sayıp geri alabiliyordu: test bazen durağan kare yayınlıyordu).
  await kosulBekle(wc, "window.__odaDurumu?.().oynatici.state === 'ready'", 20000);
  await wc.executeJavaScript("window.__odaDurumu().playback.paused && document.querySelector('#btn-play').click()").catch(() => {});
  await kosulBekle(wc, "!document.querySelector('#video').paused", 10000);
  await bekle(3000);
  const pencereler = () => BrowserWindow.getAllWindows().map((w) => ({ cocuk: Boolean(w.getParentWindow()), gorunur: w.isVisible(), sinir: w.getBounds() }));
  sonuc.pencereler_once = pencereler();
  sonuc.mpv_calisiyor = require('node:child_process').execSync('tasklist /FI "IMAGENAME eq mpv.exe" /FO CSV /NH').toString().includes('mpv.exe');
  sonuc.oda_once = await wc.executeJavaScript('JSON.stringify(window.__odaDurumu?.())').catch((e) => String(e));
  sonuc.oynatici_once = await wc.executeJavaScript("({ paused: document.querySelector('#video').paused, t: document.querySelector('#video').currentTime, oda: document.querySelector('#banner-text')?.textContent })").catch(() => null);
  yaz(SONUC, sonuc);  await wc.executeJavaScript(`(() => {
    document.querySelector('#yayin-ac').click();
    document.querySelector('#yayin-kalite').value = ${JSON.stringify(kalite)};
    document.querySelector('#yayin-sinir').value = '4';
    document.querySelector('#yayin-basla').click();
  })()`, true); // true: kullanici eylemi (getDisplayMedia bunu ister)
  not(await kosulBekle(wc, "document.querySelector('#yayin-ac').classList.contains('yayinda')", 15000) ? 'yayin basladi' : 'YAYIN BASLAMADI');
  sonuc.pencereler_sonra = pencereler();
  sonuc.ipc = ipcKayit.slice(-15);
  sonuc.uyarilar = await wc.executeJavaScript("[...document.querySelectorAll('.toast, .toasts > *')].map((t) => t.textContent)").catch(() => []);
  sonuc.oynatici = await wc.executeJavaScript("({ paused: document.querySelector('#video').paused, src: document.querySelector('#video').currentSrc })").catch(() => null);
  const son = Date.now() + sure;
  while (Date.now() < son) {
    const d = await wc.executeJavaScript(`({ yazi: document.querySelector('#yayin-ac-yazi').textContent, ipucu: document.querySelector('#yayin-ac').title, oynuyor: !document.querySelector('#video').paused, t: Math.round(document.querySelector('#video').currentTime), bekleme: document.querySelector('#banner').hidden ? null : document.querySelector('#banner-text').textContent })`).catch(() => null);
    if (d) { sonuc.durumlar.push({ t: Date.now(), ...d }); yaz(SONUC, sonuc); }
    await bekle(2000);
  }
  app.exit(0);
});
