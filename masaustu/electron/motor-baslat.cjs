// Stremio'suz çalışma (masaüstü): bu bilgisayarda 11470'te yayın sunucusu yoksa (Stremio kapalı ya
// da kurulu değil, aynı bilgisayarda Birlikte İzle sunucusu da çalışmıyor) TorrServer motorunu ve
// önündeki Stremio taklidini uygulama kendisi açar. Uygulamanın geri kalanı (stremio-vekil, oynatıcı)
// hiç değişmeden 11470'i kullanıyor.
//
// Motor kodu sunucuyla ortak (src/motor): güncellemeyle motor/ klasörüne iniyor, kurulum paketine
// motor-kopyala.cjs koyuyor, geliştirirken depodaki src/motor okunuyor. TorrServer programı ilk
// gerektiğinde indiriliyor (yaklaşık 64 MB, kullanıcı klasörüne).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function motorKlasoru() {
  const adaylar = [path.join(__dirname, '..', 'motor'), path.join(__dirname, '..', '..', 'src', 'motor')];
  return adaylar.find((k) => fs.existsSync(path.join(k, 'torrserver.js'))) || null;
}

async function acikMi(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/settings`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// Motor açıldıysa { durdur }, gerek yoksa ya da açılamadıysa null.
// tsPort: sunucunun TorrServer'ı (8097) aynı bilgisayarda olsa da çakışmasın diye ayrı.
async function motoruHazirla({ klasor, gunluk, port = 11470, tsPort = 8098 }) {
  if (await acikMi(port)) return null;
  const kok = motorKlasoru();
  if (!kok) {
    gunluk('motor: dosyaları yok, Stremio gerekiyor');
    return null;
  }
  const yaz = (tur) => (mesaj, ek) => gunluk(`motor ${tur}: ${mesaj}${ek ? ` ${JSON.stringify(ek)}` : ''}`);
  const log = { info: yaz('bilgi'), warn: yaz('uyarı'), error: yaz('hata') };
  const { createTorrServer } = await import(pathToFileURL(path.join(kok, 'torrserver.js')).href);
  const { createStremioTaklidi } = await import(pathToFileURL(path.join(kok, 'stremio-taklidi.js')).href);
  const ts = createTorrServer({ klasor, port: tsPort, log });
  const taklit = createStremioTaklidi({ ts, port, log });
  // Önce 11470'i tut (o arada Stremio açılırsa burada hata verir), sonra TorrServer'ı aç.
  await taklit.baslat();
  try {
    await ts.baslat();
  } catch (err) {
    taklit.durdur();
    throw err;
  }
  return {
    durdur() {
      taklit.durdur();
      ts.durdur();
    },
  };
}

module.exports = { motoruHazirla };
