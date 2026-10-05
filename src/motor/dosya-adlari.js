// Torrent'teki dosyanın adı (Torrentio'nun behaviorHints.filename'i): TorrServer dolgu dosyalarını
// saymadığı için sıra numarası kayabiliyor, dosya adıyla eşleştiriliyor (bkz. stremio-taklidi.js).

const adlar = new Map(); // `${infoHash}/${fileIdx}` -> ad

export function dosyaAdiKaydet(infoHash, fileIdx, ad) {
  if (!infoHash || !ad) return;
  adlar.set(`${infoHash}/${Number.isInteger(fileIdx) ? fileIdx : -1}`, ad);
  // Bellek sınırsız büyümesin (eklenti sonuçları her aramada geliyor).
  if (adlar.size > 5000) adlar.delete(adlar.keys().next().value);
}

export const dosyaAdi = (infoHash, fileIdx) => adlar.get(`${infoHash}/${fileIdx}`) || null;
