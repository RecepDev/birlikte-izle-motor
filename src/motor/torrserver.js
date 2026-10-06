// TorrServer (github.com/YouROK/TorrServer, Go + anacrolix/torrent): Stremio'nun yayın sunucusunun
// yerine kullanılan torrent motoru. Ayrı bir süreç olarak açılıyor, yalnızca 127.0.0.1'i dinliyor.
// Program ilk açılışta GitHub'dan indirilip data/araclar altına konuyor (yaklaşık 64 MB).
//
// Motor ölçümü (deneme/motor, docs/stremiosuz-plan.md): Stremio'ya en yakın sonuç bu; uTP ve
// UPnP ile port açma var (Stremio'da ikisi de yok), yükleme hızı sınırı kendi ayarı.

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SURUM = 'MatriX.145.2';
const INDIRME = `https://github.com/YouROK/TorrServer/releases/download/${SURUM}/TorrServer-windows-amd64.exe`;

// Bizim kullanımımıza göre ayarlar (gerisi TorrServer'ın varsayılanı):
// - Bağlantı sınırı Stremio'daki gibi 80 (varsayılan 25; ev modeminin bağlantı tablosu da düşünülerek).
// - Önbellek RAM'de 512 MB: host'un oynatıcısı ve relay'deki misafirler farklı yerleri okuyabiliyor.
// - Okuyan kalmayınca torrent 2 dk sonra kapanıyor. 30 sn'de duraklatıp dönünce peer'ler sıfırdan
//   bulunuyordu. Sunucuda odası kalmayan torrent'i zaten sunucu kapatıyor (bizim-torrentler.js).
// - Kapanınca önbelleği silinsin.
export const AYARLAR = {
  ConnectionsLimit: 80,
  CacheSize: 512 * 1024 * 1024,
  ReaderReadAHead: 95,
  TorrentDisconnectTimeout: 120,
  RemoveCacheOnDrop: true,
  EnableDLNA: false,
  EnableBonjour: false,
  EnableRutorSearch: false,
  EnableTorznabSearch: false,
};

// TorrServer'ın kendi varsayılan tracker listesi eski (çoğu kapanmış Rus tracker'ı). RetrackersMode 1 ile
// her torrent'e eklenen liste bununla değişiyor; sunucu güncel listeyi (ngosang, src/torrent-hiz.js) öne koyuyor.
export const IYI_TRACKERLAR = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.opentrackr.org:1337/announce',
];

// Ayar yazmak TorrServer'da açık bütün torrent'leri kapatıp BT istemcisini yeniden kuruyor
// (torr.SetSettings: dropAllTorrent + Disconnect): izlerken yazılırsa oynatma kopar.
const ayarDegisti = (eski, yeni) => Object.keys(yeni).some((k) => JSON.stringify(eski?.[k]) !== JSON.stringify(yeni[k]));

// Port hem TCP hem UDP'de (uTP, DHT) boş mu.
function bosMu(p) {
  const tcp = new Promise((r) => {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.listen({ port: p, host: '0.0.0.0', exclusive: true }, () => s.close(() => r(true)));
  });
  const udp = new Promise((r) => {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { s.close(); r(false); });
    s.bind(p, '0.0.0.0', () => s.close(() => r(true)));
  });
  return Promise.all([tcp, udp]).then(([a, b]) => a && b);
}

// trackerlar: güncel tracker listesi (fonksiyon, açılışta okunur).
// bekci: true dönerse TorrServer beklenmedik kapanınca kendini yeniden açar (panelden; varsayılan kapalı).
export function createTorrServer({
  klasor, port = 8097, log, fetchImpl = fetch, spawnImpl = spawn, trackerlar = () => [], bekci = () => false, portBosMu = bosMu,
}) {
  const exe = path.join(klasor, 'araclar', 'TorrServer.exe');
  const veri = path.join(klasor, 'torrserver');
  const portDosyasi = path.join(veri, 'peer-port.txt');
  const adres = `http://127.0.0.1:${port}`;
  let cocuk = null;
  let durduruldu = false;
  let peerPort = 0;
  let bekleyenYukleme; // izleme sürerken istenen yükleme sınırı (KB/sn; 0 = sınırsız), torrent kalmayınca yazılır
  let bekleyenZaman = null;
  const cokusler = []; // bekçinin son 10 dakikadaki yeniden açışları

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

  // Peer portu sabit: ilk açılışta boş bir port seçilip saklanıyor. TorrServer her açılışta rastgele port
  // alınca modemdeki UPnP yönlendirmesi ve DHT/tracker'lara duyurulan adres eskiyor, gelen bağlantılar boşa gidiyor.
  async function peerPortuSec(simdiki) {
    let p = 0;
    try { p = Number(fs.readFileSync(portDosyasi, 'utf8').trim()) || 0; } catch { /* ilk açılış */ }
    if (p && (p === simdiki || (await portBosMu(p)))) return p;
    for (let i = 0; i < 20; i++) {
      const aday = 20000 + Math.floor(Math.random() * 40000);
      if (await portBosMu(aday)) {
        try { fs.writeFileSync(portDosyasi, String(aday)); } catch { /* */ }
        return aday;
      }
    }
    return 0; // boş port bulunamadı: TorrServer kendisi seçsin
  }

  async function ayarla() {
    const simdiki = await (await api('/settings', { action: 'get' })).json();
    const sets = { ...simdiki, ...AYARLAR, RetrackersMode: 1 };
    const tr = [...new Set([...(trackerlar() || []), ...IYI_TRACKERLAR])].slice(0, 40);
    sets.DefaultTrackers = tr.join('\n');
    const p = await peerPortuSec(Number(simdiki?.PeersListenPort) || 0);
    if (p) sets.PeersListenPort = p;
    if (bekleyenYukleme !== undefined) sets.UploadRateLimit = bekleyenYukleme;
    if (ayarDegisti(simdiki, sets)) await api('/settings', { action: 'set', sets });
    bekleyenYukleme = undefined;
    peerPort = sets.PeersListenPort || 0;
  }

  // Bekçi: beklenmedik kapanışta 2 sn sonra yeniden açar; 10 dakikada 3'ten fazla çökerse vazgeçer.
  function bekciAc() {
    const simdi = Date.now();
    while (cokusler.length && simdi - cokusler[0] > 10 * 60_000) cokusler.shift();
    if (cokusler.length >= 3) {
      log.error('TorrServer üst üste çöktü, bekçi yeniden açmıyor (10 dakikada 3 kez)');
      return;
    }
    cokusler.push(simdi);
    setTimeout(() => {
      if (durduruldu || cocuk) return;
      log.warn('Bekçi: TorrServer yeniden açılıyor');
      baslat().catch((err) => log.error('Bekçi: TorrServer açılamadı', { error: err.message }));
    }, 2000).unref?.();
  }

  async function baslat() {
    durduruldu = false;
    await indir();
    fs.mkdirSync(veri, { recursive: true });
    if (!(await hazirMi())) {
      const c = spawnImpl(exe, ['-p', String(port), '-i', '127.0.0.1', '-d', veri], { stdio: 'ignore', windowsHide: true });
      cocuk = c;
      c.on('exit', (kod) => {
        // Yeniden başlatmada eski sürecin geç gelen "exit"i yenisinin kaydını silmesin.
        if (cocuk !== c) return;
        cocuk = null;
        if (durduruldu) return;
        log.warn('TorrServer kapandı', { kod });
        if (bekci()) bekciAc();
      });
      for (let i = 0; i < 60 && !(await hazirMi()); i++) await new Promise((r) => setTimeout(r, 250));
      if (!(await hazirMi())) throw new Error('TorrServer açılmadı');
    }
    await ayarla();
    log.info('TorrServer hazır', { port, peerPort });
  }

  // Sunucumuz zorla kapatılırsa (görev yöneticisi, taskkill) TorrServer arkada açık kalıyor; bir
  // sonraki açılışta portta hazır bulunup yeniden kullanılıyor. Düzgün kapanışta /shutdown ile de kapatılıyor.
  function durdur() {
    durduruldu = true;
    fetchImpl(`${adres}/shutdown`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
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
    // İzleme sürerken istenip bekleyen sınır da sayılır (aşağıya bak).
    async yuklemeSiniri() {
      const kb = bekleyenYukleme !== undefined
        ? bekleyenYukleme
        : Number((await (await api('/settings', { action: 'get' })).json())?.UploadRateLimit) || 0;
      return kb > 0 ? Math.round((kb * 1024 * 8) / 1e5) / 10 : null;
    },
    // Açık torrent varken ayar yazmak onları kapatır (oynatma kopar): sınır bekletilir, torrent
    // kalmayınca (15 sn'de bir bakılıyor) ya da TorrServer yeniden açılınca yazılır.
    async yuklemeSiniriKoy(mbps) {
      try {
        const kb = mbps ? Math.max(1, Math.round((mbps * 1e6) / 8 / 1024)) : 0;
        bekleyenYukleme = kb;
        if ((await this.torrentler().catch(() => [])).length) {
          if (!bekleyenZaman) {
            bekleyenZaman = setInterval(async () => {
              if (bekleyenYukleme !== undefined && (await this.torrentler().catch(() => [1])).length) return;
              clearInterval(bekleyenZaman);
              bekleyenZaman = null;
              if (bekleyenYukleme === undefined) return;
              await ayarla().catch((err) => log.warn('TorrServer yükleme sınırı yazılamadı', { error: err.message }));
            }, 15_000);
            bekleyenZaman.unref?.();
          }
          return { ok: true, mbps: await this.yuklemeSiniri(), bekliyor: true };
        }
        await ayarla();
        return { ok: true, mbps: await this.yuklemeSiniri() };
      } catch (err) {
        log.warn('TorrServer yükleme sınırı ayarlanamadı', { error: err.message });
        return { error: 'motor' };
      }
    },
    // Panel için: sürüm, peer portu, bekçinin son 10 dakikadaki yeniden açışları.
    durum: async () => ({ surum: SURUM, peerPort, calisiyor: await hazirMi(), yenidenAcilis: cokusler.length }),
    akisAdresi: (infoHash, dosyaId) => `${adres}/stream?link=${infoHash}&index=${dosyaId}&play`,
  };
}
