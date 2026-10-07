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
// onbellekGb: video önbelleği boyutu (açılış ekranından elle; 0 = kapalı).
// bekci: true dönerse TorrServer çökünce kendini yeniden açar (açılış ekranından; varsayılan kapalı).
// onBirak: aynı bilgisayardaki sunucu sonradan açılıp 11470'i isteyince motor kapanır, sonra bu çağrılır.
// Uygulama 11470'i kullanmaya devam eder, artık sunucunun motoruna gider.
async function motoruHazirla({ klasor, gunluk, port = 11470, tsPort = 8098, onbellekGb = 5, bekci = () => false, onBirak = () => {} }) {
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
  const { createOnbellek } = await import(pathToFileURL(path.join(kok, 'onbellek.js')).href);
  const ts = createTorrServer({ klasor, port: tsPort, log, bekci });
  // Video önbelleği: izlenen yerler kullanıcı klasöründe kalıyor.
  let gb = onbellekGb;
  const onbellek = createOnbellek({ klasor: path.join(klasor, 'onbellek'), sinirBayt: gb * 1024 ** 3, log });
  onbellek.temizle();
  const temizlik = setInterval(() => onbellek.temizle(), 10 * 60_000);
  function durdur() {
    clearInterval(temizlik);
    taklit.durdur();
    ts.durdur();
  }
  const taklit = createStremioTaklidi({
    ts, port, log, onbellek,
    birak: () => {
      log.info('11470 bu bilgisayardaki sunucuya bırakılıyor');
      durdur();
      onBirak();
    },
  });
  // Önce 11470'i tut (o arada Stremio açılırsa burada hata verir), sonra TorrServer'ı aç.
  await taklit.baslat();
  try {
    await ts.baslat();
  } catch (err) {
    taklit.durdur();
    throw err;
  }
  return {
    durum: () => ts.durum(),
    onbellekGb: () => gb,
    onbellekAyarla(yeni) {
      gb = yeni;
      return onbellek.sinirAyarla(yeni * 1024 ** 3);
    },
    durdur,
  };
}

module.exports = { motoruHazirla };
