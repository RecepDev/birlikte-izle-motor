// Başlatıcı: indirilmiş daha yeni kod varsa onu, yoksa paketteki kodu çalıştırır.
//
// Güncellemeler (ana.cjs, köprü, stil…) host'un sunucusundan kullanıcı klasörüne
// iniyor (bkz. ana.cjs -> guncellemeDenetle). Electron ve mpv pakette kalıyor; yalnızca
// kod değiştiği için güncelleme birkaç yüz KB.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const paketSurumu = require('../package.json').version;

// "0.10.2" > "0.9.9" gibi karşılaştırma.
function dahaYeni(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const fark = (pa[i] || 0) - (pb[i] || 0);
    if (fark) return fark > 0;
  }
  return false;
}

const guncelKlasor = path.join(app.getPath('userData'), 'guncelleme');
let hedef = path.join(__dirname, 'ana.cjs');
let surum = paketSurumu;
try {
  const indirilen = JSON.parse(fs.readFileSync(path.join(guncelKlasor, 'surum.json'), 'utf8')).surum;
  const guncelAna = path.join(guncelKlasor, 'electron', 'ana.cjs');
  if (dahaYeni(indirilen, paketSurumu) && fs.existsSync(guncelAna)) {
    hedef = guncelAna;
    surum = indirilen;
  }
} catch { /* güncelleme yok */ }

global.kabuk = { surum, dahaYeni, guncelKlasor };
require(hedef);
