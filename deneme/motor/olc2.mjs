// Aşama 0 ölçümü, ikinci sürüm (adil koşullar).
//
// İlk sürümün sorunları:
// - Stremio'nun önbelleğinde test torrent'lerinden 137-169 MB hazırdı, açılış/sarma diskten geldi.
// - torrent-stream ve webtorrent her denemede DHT'yi sıfırdan kuruyordu; Stremio'nunki saatlerdir ısınık.
// - 3 torrent, tek tur: dalgalanma sonucu gizliyordu.
//
// Bu sürümde:
// - Torrent'ler her çalıştırmada Torrentio'dan yeni seçiliyor: Stremio önbelleğinde olmayan, daha önce
//   denenmemiş (kullanilan.json) olanlar. Her motor her torrent'i bir kez, ilk kez açıyor.
// - Kalıcı motorlar (webtorrent istemcisi, torrent-stream'in ortak DHT'si) başta 60 sn ısınıyor.
// - Kategoriler: 1080p çok kaynaklı, 4K çok kaynaklı, 1080p az kaynaklı (gerçek hayattaki zor durum).
// - Sıra her torrent'te kayıyor; her ölçüm adımının kendi zaman aşımı var, biri takılınca ötekiler sürüyor.
// - Başta hattın hızı ölçülüyor (Cloudflare), motorların hattı doldurup doldurmadığı görülsün.
//
// Çalıştır: node olc2.mjs   (Stremio açık olmalı; ölçüm boyunca başka indirme/izleme yapılmamalı)
// MOTORLAR=stremio,torrent-stream,webtorrent,rqbit,torrserver,libtorrent  TORRENT_SAYISI=6  ISINMA_SN=60
// TORRENT=<hash>:<sıra>  (Torrentio seçimi yerine tek torrent; kodu denemek için)  IZLE_SN=30
// Yardımcı programlar araclar/ altında (rqbit.exe, TorrServer.exe), libtorrent .venv-lt'de.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import torrentStream from 'torrent-stream';
import WebTorrent from 'webtorrent';
import DHT from 'bittorrent-dht';
import { dosyaSec } from '../../src/motor/stremio-taklidi.js';

const BURASI = path.dirname(new URL(import.meta.url).pathname.slice(1));
const STREMIO = 'http://127.0.0.1:11470';
const STREMIO_ONBELLEK = path.join(process.env.LOCALAPPDATA || '', 'Stremio', 'stremio-cache');
const TORRENTIO = 'https://torrentio.strem.fun';
const MB = 1024 * 1024;
const ILK = 2 * MB;
const IZLE_MS = (Number(process.env.IZLE_SN) || 30) * 1000;
const ACILIS_MS = 120_000;
const SARMA_MS = 60_000;
const ISINMA_MS = (Number(process.env.ISINMA_SN) || 60) * 1000;
const TORRENT_SAYISI = Number(process.env.TORRENT_SAYISI) || 6;
const SECILI = (process.env.MOTORLAR || 'stremio,torrent-stream,webtorrent,rqbit,torrserver,libtorrent').split(',');

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const yuvarla = (n, k = 1) => Math.round(n * 10 ** k) / 10 ** k;
const log = (...a) => console.log(...a);

// ---- torrent seçimi ---------------------------------------------------------------------
const BASLIKLAR = [
  'movie/tt0468569', 'movie/tt0133093', 'movie/tt0110912', 'movie/tt0109830', 'movie/tt0120737',
  'movie/tt1745960', 'movie/tt15398776', 'movie/tt1160419', 'movie/tt6751668', 'movie/tt0137523',
  'movie/tt0167260', 'movie/tt4154796', 'series/tt0903747:1:1', 'series/tt0944947:1:1', 'series/tt1190634:1:1',
];
const KATEGORILER = [
  { ad: '1080p çok kaynak', uygun: (s) => s.kalite === '1080p' && s.seed >= 50 && s.gb >= 1.5 && s.gb <= 8 },
  { ad: '4K çok kaynak', uygun: (s) => s.kalite === '2160p' && s.seed >= 40 && s.gb >= 6 },
  { ad: '1080p az kaynak', uygun: (s) => s.kalite === '1080p' && s.seed >= 6 && s.seed <= 25 && s.gb >= 1 },
];

function kullanilanlar() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(BURASI, 'kullanilan.json'), 'utf8'))); } catch { return new Set(); }
}

async function torrentSec() {
  const kullanilan = kullanilanlar();
  const onbellekte = new Set(fs.existsSync(STREMIO_ONBELLEK) ? fs.readdirSync(STREMIO_ONBELLEK) : []);
  const adaylar = [];
  for (const b of BASLIKLAR) {
    try {
      const { streams = [] } = await (await fetch(`${TORRENTIO}/stream/${b}.json`, { signal: AbortSignal.timeout(15_000) })).json();
      for (const s of streams) {
        if (!s.infoHash) continue;
        const ih = s.infoHash.toLowerCase();
        if (kullanilan.has(ih) || onbellekte.has(ih)) continue;
        const metin = `${s.name || ''} ${s.title || ''}`;
        const seed = Number(metin.match(/👤\s*(\d+)/)?.[1]) || 0;
        const boy = metin.match(/💾\s*([\d.]+)\s*(GB|MB)/);
        const gb = boy ? Number(boy[1]) / (boy[2] === 'MB' ? 1024 : 1) : 0;
        const kalite = /2160p|4k/i.test(metin) ? '2160p' : /1080p/i.test(metin) ? '1080p' : 'diger';
        // fileIdx yoksa -1: motor en büyük dosyayı seçer (Stremio da öyle yapıyor).
        adaylar.push({ baslik: b, ih, idx: Number.isInteger(s.fileIdx) ? s.fileIdx : -1, dosyaAdi: s.behaviorHints?.filename || null, seed, gb, kalite });
      }
    } catch (err) {
      log(`  (Torrentio ${b}: ${err.message})`);
    }
  }
  const secilen = [];
  const kac = Math.ceil(TORRENT_SAYISI / KATEGORILER.length);
  for (const k of KATEGORILER) {
    const uygunlar = adaylar.filter(k.uygun).sort((a, b) => b.seed - a.seed);
    const basliklar = new Set();
    for (const a of uygunlar) {
      if (secilen.filter((s) => s.kategori === k.ad).length >= kac) break;
      if (basliklar.has(a.baslik) || secilen.some((s) => s.ih === a.ih)) continue;
      basliklar.add(a.baslik);
      secilen.push({ ...a, kategori: k.ad, ad: `${k.ad} · ${a.seed} seed · ${yuvarla(a.gb)} GB · ${a.baslik}` });
    }
  }
  return secilen.slice(0, TORRENT_SAYISI);
}

function trackerlar() {
  return JSON.parse(fs.readFileSync(path.join(BURASI, '..', '..', 'data', 'trackerlar.json'), 'utf8')).liste;
}

// ---- ortak okuma ölçümü -----------------------------------------------------------------
// motor.oku(bas, son, signal) -> Readable. Hedef bayta ulaşınca, süre dolunca ya da akış bitince
// sonlanır; akış her durumda kapatılır (takılı okuma bir sonraki ölçüme taşmasın).
function olcOku(motor, bas, son, { hedef = Infinity, sureMs }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  return new Promise((resolve) => {
    let bayt = 0;
    let bitti = false;
    let akis = null;
    const kapat = (tamam) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(zaman);
      ctrl.abort();
      try { akis?.destroy(); } catch { /* */ }
      resolve({ bayt, sure: (Date.now() - t0) / 1000, tamam });
    };
    const zaman = setTimeout(() => kapat(hedef === Infinity), sureMs);
    Promise.resolve()
      .then(() => motor.oku(bas, son, ctrl.signal))
      .then((a) => {
        if (bitti) { a.destroy(); return; }
        akis = a;
        a.on('data', (p) => { bayt += p.length; if (bayt >= hedef) kapat(true); });
        a.on('end', () => kapat(hedef === Infinity || bayt >= hedef));
        a.on('error', () => kapat(false));
      })
      .catch(() => kapat(false));
  });
}

async function olc(motor, d) {
  const sonuc = { acilis: null, izlemeMbps: null, sarma35: null, sarma80: null, peer: 0, hata: null };
  const peerTakip = setInterval(async () => {
    try { sonuc.peer = Math.max(sonuc.peer, (await motor.peer()) || 0); } catch { /* */ }
  }, 1000);
  try {
    const t0 = Date.now();
    await Promise.race([motor.ac(d), bekle(ACILIS_MS).then(() => { throw new Error('metadata zaman aşımı'); })]);
    const kalan = ACILIS_MS - (Date.now() - t0);
    const a = await olcOku(motor, 0, ILK - 1, { hedef: ILK, sureMs: Math.max(kalan, 1000) });
    if (!a.tamam) throw new Error('açılış zaman aşımı');
    sonuc.acilis = yuvarla((Date.now() - t0) / 1000);
    const boyut = motor.boyut();
    const iz = await olcOku(motor, ILK, Math.min(boyut - 1, ILK + 4096 * MB), { sureMs: IZLE_MS });
    sonuc.izlemeMbps = yuvarla((iz.bayt * 8) / 1e6 / iz.sure);
    for (const [ad, oran] of [['sarma35', 0.35], ['sarma80', 0.8]]) {
      const bas = Math.floor(boyut * oran);
      const s = await olcOku(motor, bas, Math.min(boyut - 1, bas + ILK - 1), { hedef: ILK, sureMs: SARMA_MS });
      sonuc[ad] = s.tamam ? yuvarla(s.sure) : null;
    }
  } catch (err) {
    sonuc.hata = err.message;
  } finally {
    clearInterval(peerTakip);
    await Promise.race([motor.kapat(d).catch(() => {}), bekle(15_000)]);
  }
  return sonuc;
}

// ---- motorlar ---------------------------------------------------------------------------
// Her motor: hazirla() (kalıcı istemci, DHT), ac(d), oku(bas, son, signal), boyut(), peer(), kapat(d), bitir().

function stremioMotor() {
  let adres = null;
  let boy = null;
  let ih = null;
  return {
    async hazirla() {
      const r = await fetch(`${STREMIO}/settings`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('Stremio kapalı');
    },
    async ac(d) {
      ih = d.ih;
      boy = null;
      // Canlı kodla aynı biçim: tracker'lar "tracker:" önekiyle (public/js/shared/stream-url.js).
      const q = [...d.tr.map((t) => `tracker:${t}`), `dht:${d.ih}`].map((t) => `tr=${encodeURIComponent(t)}`).join('&');
      adres = `${STREMIO}/${d.ih}/${d.idx}?${q}`;
    },
    async oku(bas, son, signal) {
      const res = await fetch(adres, { headers: { range: `bytes=${bas}-${son}` }, signal });
      boy ||= Number(String(res.headers.get('content-range') || '').split('/')[1]) || null;
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return Readable.fromWeb(res.body);
    },
    boyut: () => boy,
    async peer() {
      const s = await (await fetch(`${STREMIO}/${ih}/stats.json`, { signal: AbortSignal.timeout(1500) })).json();
      return s?.peers || 0;
    },
    async kapat(d) {
      await fetch(`${STREMIO}/${d.ih}/remove`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
    },
    async bitir() {},
  };
}

// torrent-stream (Stremio'nun çekirdeği). Stremio gibi ortak, sürekli açık bir DHT kullanıyor.
function tsMotor() {
  let dht = null;
  let engine = null;
  let dosya = null;
  let klasor = null;
  return {
    async hazirla() {
      dht = new DHT();
      dht.on('error', () => {});
      dht.listen();
    },
    async ac(d) {
      klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-ts-'));
      engine = torrentStream(`magnet:?xt=urn:btih:${d.ih}`, { path: klasor, trackers: d.tr, connections: 80, uploads: 4, dht });
      await new Promise((r) => engine.on('ready', r));
      dosya = engine.files[d.idx] || engine.files.reduce((a, b) => (b.length > a.length ? b : a));
    },
    async oku(bas, son, signal) {
      const s = dosya.createReadStream({ start: bas, end: son });
      signal.addEventListener('abort', () => s.destroy(), { once: true });
      return s;
    },
    boyut: () => dosya.length,
    peer: () => engine?.swarm.wires.length || 0,
    async kapat() {
      const e = engine;
      engine = null;
      if (!e) return;
      await new Promise((r) => e.remove(false, () => e.destroy(r)));
      fs.rmSync(klasor, { recursive: true, force: true });
    },
    async bitir() { dht?.destroy(); },
  };
}

function wtMotor() {
  let istemci = null;
  let torrent = null;
  let dosya = null;
  let klasor = null;
  return {
    async hazirla() {
      istemci = new WebTorrent({ maxConns: 80 });
      istemci.on('error', () => {});
    },
    async ac(d) {
      klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-wt-'));
      torrent = istemci.add(`magnet:?xt=urn:btih:${d.ih}`, { path: klasor, announce: d.tr });
      torrent.on('error', () => {});
      await new Promise((r) => { if (torrent.files?.length) r(); else { torrent.once('ready', r); torrent.once('metadata', r); } });
      dosya = torrent.files[d.idx] || torrent.files.reduce((a, b) => (b.length > a.length ? b : a));
    },
    async oku(bas, son, signal) {
      const s = dosya.createReadStream({ start: bas, end: son });
      signal.addEventListener('abort', () => s.destroy(), { once: true });
      return s;
    },
    boyut: () => dosya.length,
    peer: () => torrent?.numPeers || 0,
    async kapat() {
      const t = torrent;
      torrent = null;
      if (t) await new Promise((r) => t.destroy({ destroyStore: true }, r));
      fs.rmSync(klasor, { recursive: true, force: true });
    },
    async bitir() { await new Promise((r) => istemci.destroy(r)); },
  };
}

// ---- yardımcı programlı motorlar (ayrı süreç, HTTP) -------------------------------------
const cocuklar = [];
process.on('exit', () => { for (const c of cocuklar) try { c.kill(); } catch { /* */ } });

async function surecBaslat(exe, args, hazirAdres) {
  const c = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  cocuklar.push(c);
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(hazirAdres, { signal: AbortSignal.timeout(1000) });
      return c;
    } catch { await bekle(500); }
  }
  throw new Error(`${path.basename(exe)} açılmadı`);
}

const httpOku = (adres) => async (bas, son, signal) => {
  const res = await fetch(adres(), { headers: { range: `bytes=${bas}-${son}` }, signal });
  if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return Readable.fromWeb(res.body);
};
const magnet = (d) => `magnet:?xt=urn:btih:${d.ih}${d.tr.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
const enBuyuk = (boylar) => boylar.reduce((m, b, i) => (b > boylar[m] ? i : m), 0);

// rqbit (Rust). Bağlantı sınırı 80; kalanı varsayılan (UPnP port açma, kalıcı DHT açık).
function rqbitMotor() {
  const API = 'http://127.0.0.1:3031';
  let klasor = null;
  let id = null;
  let idx = null;
  let boy = null;
  return {
    async hazirla() {
      klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-rq-'));
      await surecBaslat(path.join(BURASI, 'araclar', 'rqbit.exe'),
        ['--http-api-listen-addr', '127.0.0.1:3031', '--peer-limit', '80', 'server', 'start', '--disable-persistence', klasor], `${API}/`);
    },
    async ac(d) {
      // Dosya sırası biliniyorsa yalnız o dosya; bilinmiyorsa duraklatılmış eklenip en büyük dosya seçiliyor.
      const sorgu = d.idx >= 0 ? `only_files=${d.idx}` : 'paused=true';
      const r = await (await fetch(`${API}/torrents?overwrite=true&${sorgu}`, { method: 'POST', body: magnet(d) })).json();
      id = r.id;
      const boylar = r.details.files.map((f) => f.length);
      idx = d.idx >= 0 ? d.idx : enBuyuk(boylar);
      boy = boylar[idx];
      if (d.idx < 0) {
        await fetch(`${API}/torrents/${id}/update_only_files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ only_files: [idx] }) });
        await fetch(`${API}/torrents/${id}/start`, { method: 'POST' });
      }
      // Eklendikten sonra kısa bir "initializing" (dosya denetimi) aşaması var; o sırada akış 500 dönüyor.
      for (;;) {
        const st = await (await fetch(`${API}/torrents/${id}/stats/v1`)).json().catch(() => null);
        if (st?.state === 'live') break;
        await bekle(100);
      }
    },
    oku: httpOku(() => `${API}/torrents/${id}/stream/${idx}`),
    boyut: () => boy,
    async peer() {
      const s = await (await fetch(`${API}/torrents/${id}/stats/v1`, { signal: AbortSignal.timeout(1500) })).json();
      return s?.live?.snapshot?.peer_stats?.live || 0;
    },
    async kapat() {
      if (id !== null) await fetch(`${API}/torrents/${id}/delete`, { method: 'POST' }).catch(() => {});
      id = null;
    },
    async bitir() {},
  };
}

// TorrServer (Go, anacrolix/torrent). Akış için yapılmış: RAM önbelleği (varsayılan 64 MB) + önden okuma.
// Bağlantı sınırı 25'ten 80'e çıkarılıyor (ötekilerle eşit).
function torrserverMotor() {
  const API = 'http://127.0.0.1:8097';
  let ih = null;
  let id = null;
  let boy = null;
  const istek = async (govde) => (await fetch(`${API}/torrents`, { method: 'POST', body: JSON.stringify(govde), signal: AbortSignal.timeout(10_000) })).json();
  return {
    async hazirla() {
      const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-tsv-'));
      await surecBaslat(path.join(BURASI, 'araclar', 'TorrServer.exe'), ['-p', '8097', '-d', klasor], `${API}/echo`);
      const ayar = await (await fetch(`${API}/settings`, { method: 'POST', body: JSON.stringify({ action: 'get' }) })).json();
      await fetch(`${API}/settings`, { method: 'POST', body: JSON.stringify({ action: 'set', sets: { ...ayar, ConnectionsLimit: 80 } }) });
    },
    async ac(d) {
      ih = d.ih;
      await istek({ action: 'add', link: magnet(d), save_to_db: false });
      for (;;) {
        const t = await istek({ action: 'get', hash: ih }).catch(() => null);
        const dosyalar = t?.file_stats;
        if (dosyalar?.length) {
          // TorrServer dolgu (pad) dosyalarını listelemiyor, sıra kayabiliyor: dosya adıyla eşleştir
          // (sunucudaki src/motor/stremio-taklidi.js dosyaSec ile aynı kural).
          const f = dosyaSec(dosyalar, d.idx, d.dosyaAdi);
          id = f.id;
          boy = f.length;
          return;
        }
        await bekle(300);
      }
    },
    oku: httpOku(() => `${API}/stream?link=${ih}&index=${id}&play`),
    boyut: () => boy,
    async peer() { return (await istek({ action: 'get', hash: ih }))?.active_peers || 0; },
    async kapat(d) {
      await istek({ action: 'drop', hash: d.ih }).catch(() => {});
      await istek({ action: 'rem', hash: d.ih }).catch(() => {});
    },
    async bitir() {},
  };
}

// libtorrent 2.1 (qBittorrent'in motoru; telefonda libtorrent4j ile aynı çekirdek). lt_sunucu.py.
function ltMotor() {
  const API = 'http://127.0.0.1:8096';
  let ih = null;
  let boy = null;
  return {
    async hazirla() {
      const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-lt-'));
      await surecBaslat(path.join(BURASI, '.venv-lt', 'Scripts', 'python.exe'), [path.join(BURASI, 'lt_sunucu.py'), '8096', klasor], `${API}/stats/yok`);
    },
    async ac(d) {
      ih = d.ih;
      const q = new URLSearchParams({ ih: d.ih, idx: String(d.idx) });
      for (const t of d.tr) q.append('tr', t);
      const r = await fetch(`${API}/add?${q}`);
      if (!r.ok) throw new Error('metadata zaman aşımı');
      boy = (await r.json()).boyut;
    },
    oku: httpOku(() => `${API}/stream/${ih}`),
    boyut: () => boy,
    async peer() { return (await (await fetch(`${API}/stats/${ih}`, { signal: AbortSignal.timeout(1500) })).json())?.peers || 0; },
    async kapat(d) { await fetch(`${API}/remove/${d.ih}`).catch(() => {}); },
    async bitir() {},
  };
}

const MOTORLAR = {
  stremio: stremioMotor, 'torrent-stream': tsMotor, webtorrent: wtMotor,
  rqbit: rqbitMotor, torrserver: torrserverMotor, libtorrent: ltMotor,
};

// ---- hat hızı ---------------------------------------------------------------------------
// Cloudflare'den 4 paralel 25 MB (100 MB'lık istek 403 dönüyor). Motorların hattı doldurup doldurmadığı görülsün.
async function hatHizi() {
  const t0 = Date.now();
  const parcalar = await Promise.all([0, 1, 2, 3].map(async () => {
    try {
      const res = await fetch('https://speed.cloudflare.com/__down?bytes=25000000', { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
      let n = 0;
      for await (const p of res.body) n += p.length;
      return n;
    } catch { return 0; }
  }));
  const bayt = parcalar.reduce((a, b) => a + b, 0);
  return yuvarla((bayt * 8) / 1e6 / ((Date.now() - t0) / 1000));
}

// ---- çalıştır ---------------------------------------------------------------------------
const medyan = (a) => {
  const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : yuvarla((s[m - 1] + s[m]) / 2);
};

const tr = trackerlar();
log(`Hat hızı: ${await hatHizi()} Mbps`);
const tekTorrent = process.env.TORRENT?.split(':');
const torrentler = (tekTorrent
  ? [{ ad: `deneme ${tekTorrent[0]}`, kategori: 'deneme', ih: tekTorrent[0].toLowerCase(), idx: Number(tekTorrent[1] ?? -1) }]
  : await torrentSec()).map((d) => ({ ...d, tr }));
if (!torrentler.length) throw new Error('Uygun torrent bulunamadı');
if (!tekTorrent) fs.writeFileSync(path.join(BURASI, 'kullanilan.json'), JSON.stringify([...kullanilanlar(), ...torrentler.map((d) => d.ih)]));
log(`Torrent'ler (${torrentler.length}):`);
for (const d of torrentler) log(`  ${d.ad}  ${d.ih}`);

const motorlar = {};
for (const ad of SECILI) {
  motorlar[ad] = MOTORLAR[ad]();
  await motorlar[ad].hazirla();
}
log(`Motorlar ısınıyor (${ISINMA_MS / 1000} sn): ${SECILI.join(', ')}`);
await bekle(ISINMA_MS);

const tablo = [];
for (let i = 0; i < torrentler.length; i++) {
  const d = torrentler[i];
  log(`\n== ${d.ad}`);
  const sira = SECILI.map((_, k) => SECILI[(k + i) % SECILI.length]);
  for (const ad of sira) {
    const t0 = Date.now();
    const s = await olc(motorlar[ad], d);
    log(`  ${ad.padEnd(15)} açılış ${s.acilis ?? '-'} sn | izleme ${s.izlemeMbps ?? '-'} Mbps | sarma %35 ${s.sarma35 ?? '-'} sn, %80 ${s.sarma80 ?? '-'} sn | peer ${s.peer}${s.hata ? ` | HATA ${s.hata}` : ''} (${yuvarla((Date.now() - t0) / 1000)} sn)`);
    tablo.push({ torrent: d.ad, kategori: d.kategori, ih: d.ih, motor: ad, ...s });
    if (!tekTorrent) fs.writeFileSync(path.join(BURASI, 'sonuc2.json'), JSON.stringify(tablo, null, 1));
    await bekle(5000);
  }
}

log('\n== Özet (medyan)');
for (const ad of SECILI) {
  const r = tablo.filter((x) => x.motor === ad);
  const ok = r.filter((x) => x.acilis !== null);
  log(`  ${ad.padEnd(15)} başarılı ${ok.length}/${r.length} | açılış ${medyan(ok.map((x) => x.acilis))} sn | izleme ${medyan(ok.map((x) => x.izlemeMbps))} Mbps | sarma %35 ${medyan(ok.map((x) => x.sarma35))} sn, %80 ${medyan(ok.map((x) => x.sarma80))} sn | peer ${medyan(ok.map((x) => x.peer))}`);
}
for (const m of Object.values(motorlar)) await Promise.race([m.bitir().catch(() => {}), bekle(5000)]);
process.exit(0);
