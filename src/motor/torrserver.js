// TorrServer (github.com/YouROK/TorrServer, Go + anacrolix/torrent): Stremio'nun yayın sunucusunun
// yerine kullanılan torrent motoru. Ayrı bir süreç olarak açılıyor, yalnızca 127.0.0.1'i dinliyor.
// Program ilk açılışta GitHub'dan indirilip data/araclar altına konuyor (yaklaşık 64 MB).
//
// Motor ölçümü (deneme/motor, docs/stremiosuz-plan.md): Stremio'ya en yakın sonuç bu; uTP ve
// UPnP ile port açma var (Stremio'da ikisi de yok), yükleme hızı sınırı kendi ayarı.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SURUM = 'MatriX.145.2';
const INDIRME = `https://github.com/YouROK/TorrServer/releases/download/${SURUM}/TorrServer-windows-amd64.exe`;

// Bizim kullanımımıza göre ayarlar (gerisi TorrServer'ın varsayılanı):
// - Bağlantı sınırı Stremio'daki gibi 80 (varsayılan 25; ev modeminin bağlantı tablosu da düşünülerek).
// - Önbellek RAM'de 512 MB: host'un oynatıcısı ve relay'deki misafirler farklı yerleri okuyabiliyor.
// - Okuyan kalmayınca torrent 30 sn sonra kapanıyor (arkada torrent kalmasın kuralı).
// - Kapanınca önbelleği silinsin.
export const AYARLAR = {
  ConnectionsLimit: 80,
  CacheSize: 512 * 1024 * 1024,
  ReaderReadAHead: 95,
  TorrentDisconnectTimeout: 30,
  RemoveCacheOnDrop: true,
  EnableDLNA: false,
  EnableBonjour: false,
  EnableRutorSearch: false,
  EnableTorznabSearch: false,
};

export function createTorrServer({ klasor, port = 8097, log, fetchImpl = fetch, spawnImpl = spawn }) {
  const exe = path.join(klasor, 'araclar', 'TorrServer.exe');
  const veri = path.join(klasor, 'torrserver');
  const adres = `http://127.0.0.1:${port}`;
  let cocuk = null;
  let durduruldu = false;

  async function indir() {
    if (fs.existsSync(exe)) return;
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    log.info('TorrServer indiriliyor', { surum: SURUM });
    const res = await fetchImpl(INDIRME, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`TorrServer indirilemedi (HTTP ${res.status})`);
    const gecici = `${exe}.indiriliyor`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(gecici));
    fs.renameSync(gecici, exe);
    log.info('TorrServer indirildi');
  }

  async function hazirMi() {
    try {
      return (await fetchImpl(`${adres}/echo`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }

  async function ayarla() {
    const simdiki = await (await api('/settings', { action: 'get' })).json();
    await api('/settings', { action: 'set', sets: { ...simdiki, ...AYARLAR } });
  }

  async function baslat() {
    durduruldu = false;
    await indir();
    fs.mkdirSync(veri, { recursive: true });
    if (!(await hazirMi())) {
      cocuk = spawnImpl(exe, ['-p', String(port), '-i', '127.0.0.1', '-d', veri], { stdio: 'ignore', windowsHide: true });
      cocuk.on('exit', (kod) => {
        cocuk = null;
        if (!durduruldu) log.warn('TorrServer kapandı', { kod });
      });
      for (let i = 0; i < 60 && !(await hazirMi()); i++) await new Promise((r) => setTimeout(r, 250));
      if (!(await hazirMi())) throw new Error('TorrServer açılmadı');
    }
    await ayarla();
    log.info('TorrServer hazır', { port });
  }

  function durdur() {
    durduruldu = true;
    try { cocuk?.kill(); } catch { /* */ }
    cocuk = null;
  }

  function api(yol, govde) {
    return fetchImpl(`${adres}${yol}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(govde),
      signal: AbortSignal.timeout(15_000),
    });
  }

  return {
    adres,
    baslat,
    durdur,
    hazirMi,
    // Takılırsa: süreci kapatıp açar (Stremio'yu yeniden başlatmanın karşılığı).
    async yenidenBaslat() {
      durdur();
      await new Promise((r) => setTimeout(r, 1000));
      await baslat();
      return { ok: true };
    },
    async torrentler() {
      return (await (await api('/torrents', { action: 'list' })).json()) || [];
    },
    async torrent(infoHash) {
      const res = await api('/torrents', { action: 'get', hash: infoHash });
      if (!res.ok) return null;
      const t = await res.json().catch(() => null);
      return t?.hash ? t : null;
    },
    async ekle(infoHash, trackerlar = []) {
      const magnet = `magnet:?xt=urn:btih:${infoHash}${trackerlar.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
      await api('/torrents', { action: 'add', link: magnet, save_to_db: false });
    },
    async kapat(infoHash) {
      await api('/torrents', { action: 'drop', hash: infoHash }).catch(() => {});
    },
    // Yükleme (upload) hız sınırı, Mbps ya da null (sınırsız). TorrServer KB/sn olarak tutuyor.
    async yuklemeSiniri() {
      const kb = Number((await (await api('/settings', { action: 'get' })).json())?.UploadRateLimit) || 0;
      return kb > 0 ? Math.round((kb * 1024 * 8) / 1e5) / 10 : null;
    },
    async yuklemeSiniriKoy(mbps) {
      try {
        const simdiki = await (await api('/settings', { action: 'get' })).json();
        const kb = mbps ? Math.max(1, Math.round((mbps * 1e6) / 8 / 1024)) : 0;
        await api('/settings', { action: 'set', sets: { ...simdiki, UploadRateLimit: kb } });
        return { ok: true, mbps: await this.yuklemeSiniri() };
      } catch (err) {
        log.warn('TorrServer yükleme sınırı ayarlanamadı', { error: err.message });
        return { error: 'motor' };
      }
    },
    akisAdresi: (infoHash, dosyaId) => `${adres}/stream?link=${infoHash}&index=${dosyaId}&play`,
  };
}
