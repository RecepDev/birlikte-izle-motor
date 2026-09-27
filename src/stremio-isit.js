// Torrent'i Stremio'da önceden açar: Stremio torrent'i oluşturup kaynak (peer) aramaya başlar,
// istenen kadar baştan okunur. Kapalı aralıkla okunuyor: Stremio dosyanın tamamını arkadan
// indirmeye başlamasın (bkz. stremio-parca.js). Hata olursa sessizce geçer; oda açılınca
// torrent normal yoldan açılır.

import http from 'node:http';
import { localTorrentUrl } from '../public/js/shared/stream-url.js';
import { dokun } from './bizim-torrentler.js';

export function isit(stream, bytes = 1024 * 1024) {
  // Testlerde gerçek Stremio'ya sahte torrent açılmasın.
  if (stream?.kind !== 'torrent' || process.env.NODE_TEST_CONTEXT) return;
  dokun(stream.infoHash);
  try {
    const req = http.get(localTorrentUrl(stream, 'http://127.0.0.1:11470'), { headers: { range: `bytes=0-${bytes - 1}` } }, (r) => r.resume());
    req.on('error', () => {});
    // Arka plan işi: süreç (ya da testler) bunu beklemesin.
    req.on('socket', (sock) => sock.unref());
    req.setTimeout(120_000, () => req.destroy());
  } catch { /* geç */ }
}
