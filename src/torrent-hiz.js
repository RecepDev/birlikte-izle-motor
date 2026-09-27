// Daha çok kaynak (peer) bulmak için iki ayar:
//  1) Stremio'nun "yeterince hızlıyım" sınırı: indirme 4 MB/s'i geçip 10 peer'e ulaşınca
//     Stremio yeni peer aramayı bırakıyor (swarmPaused). 4K için bu dar; sınırı yükseltiyoruz.
//  2) Ek tracker listesi (ngosang/trackerslist, günde bir tazelenir): addon'un verdiği birkaç
//     tracker'a eklenince torrent daha çok kaynağa ulaşıyor.

import fs from 'node:fs';
import path from 'node:path';

const STREMIO = 'http://127.0.0.1:11470';
const LISTE_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const LISTE_OMRU_MS = 24 * 60 * 60_000;
// Stremio'nun kendi "ultra hızlı" profiline yakın değerler.
const HIZLI = { btDownloadSpeedSoftLimit: 25 * 1024 * 1024, btMinPeersForStable: 30, btMaxConnections: 250 };

export function createTorrentHiz({ file, log, fetchImpl = fetch }) {
  let liste = [];
  try {
    const kayit = JSON.parse(fs.readFileSync(file, 'utf8'));
    liste = Array.isArray(kayit.liste) ? kayit.liste : [];
    if (Date.now() - (kayit.at || 0) < LISTE_OMRU_MS && liste.length) return api();
  } catch { /* ilk çalıştırma */ }
  tazele();
  return api();

  async function tazele() {
    try {
      const metin = await (await fetchImpl(LISTE_URL, { signal: AbortSignal.timeout(10_000) })).text();
      const yeni = metin.split(/\s+/).filter((t) => /^(udp|https?):\/\/\S+$/.test(t)).slice(0, 40);
      if (!yeni.length) return;
      liste = yeni;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: Date.now(), liste }));
      log.info('Ek tracker listesi alındı', { adet: liste.length });
    } catch (err) {
      log.warn('Ek tracker listesi alınamadı', { error: err.message });
    }
  }

  function api() {
    return {
      // "tracker:udp://…" biçiminde, Stremio kaynak listesine eklenecek.
      kaynaklar: () => liste.map((t) => `tracker:${t}`),
      // Stremio'nun sınırlarını yükseltir (kullanıcı daha yükseğini seçtiyse dokunmaz).
      async stremioAyarla() {
        try {
          const { values } = await (await fetchImpl(`${STREMIO}/settings`, { signal: AbortSignal.timeout(5000) })).json();
          const degisecek = Object.fromEntries(Object.entries(HIZLI).filter(([k, v]) => !(Number(values?.[k]) >= v)));
          if (!Object.keys(degisecek).length) return false;
          await fetchImpl(`${STREMIO}/settings`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(degisecek), signal: AbortSignal.timeout(5000),
          });
          log.info('Stremio torrent sınırları yükseltildi', degisecek);
          return true;
        } catch (err) {
          log.warn('Stremio ayarları değiştirilemedi', { error: err.message });
          return false;
        }
      },
      // Torrent'i ek tracker'larla ve geniş peer aramasıyla Stremio'da (yeniden) oluşturur.
      async torrentAc(stream) {
        if (stream?.kind !== 'torrent') return;
        const sources = [...new Set([...(stream.sources || []), ...liste.map((t) => `tracker:${t}`), `dht:${stream.infoHash}`])];
        try {
          await fetchImpl(`${STREMIO}/${stream.infoHash}/create`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ torrent: { infoHash: stream.infoHash }, peerSearch: { sources, min: 60, max: 250 } }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch (err) {
          log.warn('Torrent yeniden açılamadı', { error: err.message });
        }
      },
    };
  }
}
