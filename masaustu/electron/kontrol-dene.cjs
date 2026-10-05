// Geliştirme denemesi: saydam kontrol çubuğu penceresini renkli bir "video" penceresinin
// üstünde açar, ekranın o bölgesinin görüntüsünü kaydeder ve çıkar.
// Kullanım: SUNUCU=http://127.0.0.1:7100 CIKTI=dosya.png npx electron electron/kontrol-dene.cjs
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SUNUCU = process.env.SUNUCU || 'http://127.0.0.1:7300';
const CIKTI = process.env.CIKTI || path.join(require('node:os').tmpdir(), 'kontrol-dene.png');

app.whenReady().then(async () => {
  const alan = { x: 100, y: 100, width: 900, height: 500 };
  const video = new BrowserWindow({ ...alan, frame: false, show: true, backgroundColor: '#000000' });
  await video.loadURL(`data:text/html,${encodeURIComponent('<body style="margin:0;height:100vh;background:linear-gradient(135deg,#d97706,#2563eb 50%,#16a34a)"></body>')}`);
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'room.html'), 'utf8');
  const cubuk = html.slice(html.indexOf('<div class="controls">'), html.indexOf('<div id="lock-hint"'));
  const kontrol = new BrowserWindow({
    parent: video, x: alan.x, y: alan.y + alan.height - 90, width: alan.width, height: 90,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'kontrol-onyukleme.cjs'), contextIsolation: false, sandbox: false },
  });
  await kontrol.loadFile(path.join(__dirname, 'kontrol.html'));
  kontrol.webContents.send('kontrol:html', { html: cubuk.replace(/<\/div>\s*<\/div>\s*$/, '</div>'), origin: SUNUCU });
  kontrol.showInactive();
  await new Promise((r) => setTimeout(r, 2500));
  const ekran = screen.getPrimaryDisplay();
  const [kaynak] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: ekran.size.width * ekran.scaleFactor, height: ekran.size.height * ekran.scaleFactor } });
  const s = ekran.scaleFactor;
  const kirp = kaynak.thumbnail.crop({ x: alan.x * s, y: alan.y * s, width: alan.width * s, height: alan.height * s });
  fs.writeFileSync(CIKTI, kirp.toPNG());
  console.log('kaydedildi', CIKTI);
  app.quit();
});
