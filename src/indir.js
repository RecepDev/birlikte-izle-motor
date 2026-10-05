// Misafir uygulamalarının güncellemesi: masaüstü ve telefon istemcileri bağlandıkları
// host'tan (bu sunucudan) güncel kodu alıyor.
//
// Masaüstü: yalnızca kod dosyaları (Electron kabuğu, köprü, stil). Electron ve mpv
// değişmediği sürece tam paketi yeniden göndermeye gerek yok.
// Telefon: köprü betiği her açılışta buradan geliyor; APK yalnızca yerel kod değişince.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

// Güncellemeyle giden masaüstü dosyaları (masaustu/ klasörüne göre).
export const MASAUSTU_DOSYALARI = [
  // "type": "module" için şart: yoksa Node mpv.js'yi modül olarak açamıyor, mpv başlamıyor.
  'package.json',
  // Sunucu bulma konusu (bkz. kesif.js): data/kesif.json'dan veriliyor.
  'kesif.json',
  'mpv.js',
  'karar.js',
  'electron/ana.cjs',
  'electron/stremio-vekil.cjs',
  'electron/kontrol.html',
  'electron/kontrol-onyukleme.cjs',
  'electron/uygulama-sesi.cs',
  'electron/uygulama-sesi.cjs',
  'electron/onyukleme-kabuk.cjs',
  'electron/video-koprusu.cjs',
  'electron/masaustu.css',
  'electron/baslangic.html',
];

export function createIndirRouter({ root, log }) {
  const router = express.Router();
  const masaustuKok = path.join(root, 'masaustu');
  const androidKok = path.join(root, 'android');
  const apk = path.join(androidKok, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

  const okuJson = (dosya) => {
    try {
      return JSON.parse(fs.readFileSync(dosya, 'utf8'));
    } catch {
      return null;
    }
  };
  const androidSurum = () => {
    const meta = okuJson(path.join(androidKok, 'app', 'build', 'outputs', 'apk', 'release', 'output-metadata.json'));
    return meta?.elements?.[0]?.versionCode ?? null;
  };

  router.get('/indir/surum.json', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      masaustu: okuJson(path.join(masaustuKok, 'package.json'))?.version ?? null,
      masaustuDosyalari: MASAUSTU_DOSYALARI,
      android: fs.existsSync(apk) ? androidSurum() : null,
    });
  });

  // Yalnızca listedeki dosyalar: bu uç tünel üzerinden herkese açık.
  router.get('/indir/masaustu/*', (req, res) => {
    const ad = req.params[0];
    if (!MASAUSTU_DOSYALARI.includes(ad)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    if (ad === 'kesif.json') return res.sendFile(path.join(root, 'data', 'kesif.json'));
    res.sendFile(path.join(masaustuKok, ad));
  });

  router.get('/indir/android/kopru.js', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').sendFile(path.join(androidKok, 'app', 'src', 'main', 'assets', 'kopru.js'));
  });

  router.get('/indir/android/birlikte-izle.apk', (req, res) => {
    if (!fs.existsSync(apk)) return res.status(404).end();
    log.info('APK indiriliyor', { ip: req.ip });
    res.type('application/vnd.android.package-archive').sendFile(apk);
  });

  return router;
}
