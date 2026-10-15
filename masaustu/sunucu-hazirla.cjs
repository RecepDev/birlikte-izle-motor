// Kurulum paketinden önce: sunucuyu (server.js, src, panel, public + yalnız çalışma bağımlılıkları) masaustu/sunucu-paket'e
// kopyalar. Paketleyici bunu resources/sunucu-paket olarak koyar; uygulama sunucuyu oradan başlatır (bkz. electron/ana.cjs).
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const kok = path.join(__dirname, '..');
const hedef = path.join(__dirname, 'sunucu-paket');
fs.rmSync(hedef, { recursive: true, force: true });
fs.mkdirSync(hedef, { recursive: true });
for (const ad of ['server.js', 'package.json', 'package-lock.json']) fs.copyFileSync(path.join(kok, ad), path.join(hedef, ad));
for (const ad of ['src', 'panel', 'public']) fs.cpSync(path.join(kok, ad), path.join(hedef, ad), { recursive: true });
// Sözlük üretim betiği paketlenmiyor (yalnız geliştirici aracı); hazır sözlük public/veri içinde.
execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: hedef, stdio: 'inherit' });
// Yer kazanmak için: hls.js'ten yalnız sunucunun servis ettiği dist/hls.min.js, tip paketleri gereksiz.
const hls = path.join(hedef, 'node_modules', 'hls.js');
for (const ad of fs.readdirSync(hls)) if (ad !== 'dist' && ad !== 'package.json') fs.rmSync(path.join(hls, ad), { recursive: true, force: true });
for (const ad of fs.readdirSync(path.join(hls, 'dist'))) if (ad !== 'hls.min.js') fs.rmSync(path.join(hls, 'dist', ad), { recursive: true, force: true });
fs.rmSync(path.join(hedef, 'node_modules', '@types'), { recursive: true, force: true });
fs.rmSync(path.join(hedef, 'node_modules', 'undici-types'), { recursive: true, force: true });
console.log('sunucu paketi hazır');
