// Canlı yayında yalnız oynatıcının (mpv) sesi: uygulama-sesi.cs'yi ilk kullanımda Windows'un kendi
// C# derleyicisiyle (.NET Framework 4, her Windows 10/11'de var) derleyip çalıştırır; yardımcı
// mpv sürecinin sesini ham PCM (48 kHz, 2 kanal, 16 bit) olarak verir. Derlenen dosya kullanıcı
// klasöründe saklanıyor (kaynak değişince yeniden derleniyor).
const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KAYNAK = path.join(__dirname, 'uygulama-sesi.cs');

function cscYolu() {
  const kok = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(kok, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(kok, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((y) => fs.existsSync(y)) || null;
}

let derleniyor = null;
function derle(klasor) {
  if (derleniyor) return derleniyor;
  derleniyor = (async () => {
    const icerik = fs.readFileSync(KAYNAK);
    const ozet = crypto.createHash('sha1').update(icerik).digest('hex').slice(0, 10);
    const exe = path.join(klasor, `uygulama-sesi-${ozet}.exe`);
    if (fs.existsSync(exe)) return exe;
    const csc = cscYolu();
    if (!csc) throw new Error('C# derleyicisi (csc.exe) bulunamadı');
    fs.mkdirSync(klasor, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile(csc, ['-nologo', '-optimize', '-platform:x64', `-out:${exe}`, KAYNAK], { windowsHide: true }, (err, stdout) => {
        if (err) reject(new Error(`derleme: ${stdout || err.message}`));
        else resolve();
      });
    });
    return exe;
  })().finally(() => { derleniyor = null; });
  return derleniyor;
}

// pid sürecinin (ve alt süreçlerinin) sesini yakalar. onVeri(Buffer) PCM parçaları alır.
// Dönen nesnenin durdur() ile kapatılır. Başlayamazsa hata fırlatır (eski Windows, izin…).
async function baslat({ pid, klasor, onVeri, onBitti = () => {} }) {
  if (process.platform !== 'win32') throw new Error('yalnız Windows');
  const exe = await derle(klasor);
  const cocuk = spawn(exe, [String(pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let hata = '';
  cocuk.stderr.on('data', (d) => { hata += d; });
  await new Promise((resolve, reject) => {
    const zaman = setTimeout(() => reject(new Error('başlamadı (zaman aşımı)')), 6000);
    cocuk.stderr.on('data', () => {
      if (hata.includes('BASLADI')) {
        clearTimeout(zaman);
        resolve();
      } else if (hata.includes('HATA')) {
        clearTimeout(zaman);
        reject(new Error(hata.trim()));
      }
    });
    cocuk.once('exit', () => {
      clearTimeout(zaman);
      reject(new Error(hata.trim() || 'kapandı'));
    });
  });
  cocuk.stdout.on('data', onVeri);
  cocuk.once('exit', onBitti);
  return { durdur: () => { try { cocuk.kill(); } catch { /* zaten kapalı */ } } };
}

module.exports = { baslat, derle };
