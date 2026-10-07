// Torrent'i Stremio'da önceden açar: Stremio torrent'i oluşturup kaynak (peer) aramaya başlar,
// istenen kadar baştan okunur. Kapalı aralıkla okunuyor: Stremio dosyanın tamamını arkadan
// indirmeye başlamasın (bkz. stremio-parca.js). Hata olursa sessizce geçer; oda açılınca
// torrent normal yoldan açılır.

import http from 'node:http';
import { localTorrentUrl, STREMIO_BASE } from '../public/js/shared/stream-url.js';
import { dokun } from './bizim-torrentler.js';

// TorrServer motorunda hız ölçümü için okunan miktar (bkz. panel-api.js torrent-denetle): TorrServer
// okuyan kalmayınca indirmeyi bırakıyor, hız ancak okurken görünüyor. Keşifte (3 aday birlikte) az
// okunuyor; umut veren aday tek başına doğrulanırken (DOGRULAMA_BAYT) dosyanın inmemiş bir yerinden.
export const OLCUM_BAYT_TS = 16 * 1024 * 1024;
export const DOGRULAMA_BAYT = 64 * 1024 * 1024;
// Ölçüm okuması en çok bu kadar sürer (yavaş kaynak arkada uzun süre inmeye devam etmesin).
const OLCUM_SURE_MS = 25_000;

// Süren ölçüm okumaları: infoHash -> istek. Doğrulamada ötekiler durduruluyor (torrent açık kalıyor,
// okuyan kalmayınca TorrServer indirmeyi bırakıyor: hat doğrulanan adaya kalıyor).
const olcumler = new Map();

export function olcumleriDurdur(haric = null) {
  for (const [ih, req] of olcumler) {
    if (ih === haric) continue;
    req.destroy();
    olcumler.delete(ih);
  }
}

// bas: okumaya başlanan bayt (doğrulamada inmemiş bir yer), sureMs: en uzun okuma süresi.
export function isit(stream, bytes = 1024 * 1024, { bas = 0, sureMs = OLCUM_SURE_MS } = {}) {
  // Testlerde gerçek Stremio'ya sahte torrent açılmasın.
  if (stream?.kind !== 'torrent' || process.env.NODE_TEST_CONTEXT) return;
  dokun(stream.infoHash);
  try {
    const req = http.get(localTorrentUrl(stream, STREMIO_BASE), { headers: { range: `bytes=${bas}-${bas + bytes - 1}` } }, (r) => r.resume());
    req.on('error', () => {});
    // Arka plan işi: süreç (ya da testler) bunu beklemesin.
    req.on('socket', (sock) => sock.unref());
    req.setTimeout(120_000, () => req.destroy());
    if (bytes > 1024 * 1024) {
      const ih = stream.infoHash;
      olcumler.get(ih)?.destroy();
      olcumler.set(ih, req);
      req.on('close', () => { if (olcumler.get(ih) === req) olcumler.delete(ih); });
      setTimeout(() => req.destroy(), sureMs).unref();
    }
  } catch { /* geç */ }
}
