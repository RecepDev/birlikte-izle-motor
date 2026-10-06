// Kurulum paketinden önce: sunucuyla ortak motor kodunu (src/motor) masaustu/motor'a kopyalar
// (bkz. electron/motor-baslat.cjs). Paketleyici yalnızca masaustu klasörünü alıyor.
const fs = require('node:fs');
const path = require('node:path');

const kaynak = path.join(__dirname, '..', 'src', 'motor');
const hedef = path.join(__dirname, 'motor');
fs.mkdirSync(hedef, { recursive: true });
for (const ad of ['torrserver.js', 'stremio-taklidi.js']) fs.copyFileSync(path.join(kaynak, ad), path.join(hedef, ad));
console.log('motor kopyalandı');
