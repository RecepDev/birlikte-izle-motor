// Aşama 0 ölçümü: aynı torrent'leri Stremio, torrent-stream ve webtorrent ile sırayla açar.
// Her biri için: ilk 2 MB'a kadar geçen süre (açılış), 30 sn sıralı okuma hızı (izleme),
// dosyanın %60'ına sarınca 2 MB'a kadar geçen süre (sarma), en çok bağlı kişi (peer).
// Aynı tracker listesi üçüne de veriliyor. Her denemeden sonra torrent kapatılıp indirilenler siliniyor.
// Çalıştır: node olc.mjs   (Stremio açık olmalı)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import torrentStream from 'torrent-stream';
import WebTorrent from 'webtorrent';

const STREMIO = 'http://127.0.0.1:11470';
const MB = 1024 * 1024;
const ILK = 2 * MB;
const IZLE_MS = 30_000;
const ZAMAN_ASIMI = 90_000;

const DENEMELER = [
  { ad: '1080p · 71 seed · 2 GB', tur: 'movie/tt1375666', ih: '2b4fba86244a317b5e607fbff1755cb4d8599281', idx: 0 },
  { ad: '4K · 127 seed · 17 GB', tur: 'movie/tt0816692', ih: 'abf5451366b96d8c518a7f56820f7d247b11222d', idx: 0 },
  { ad: '4K · 100 seed · 6.6 GB', tur: 'movie/tt1375666', ih: '43e3691dc6f4172841e32b25b349e2b7a980b9c5', idx: 0 },
];
// Sıra her torrent'te kayıyor: önce açılan motor sürüye ilk bağlanan olmasın diye.
const SIRALAR = [['stremio', 'torrent-stream', 'webtorrent'], ['torrent-stream', 'webtorrent', 'stremio'], ['webtorrent', 'stremio', 'torrent-stream']];

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const sure = (t0) => Math.round((Date.now() - t0) / 100) / 10;
const zamanla = (p, ms, ad) => Promise.race([p, bekle(ms).then(() => { throw new Error(`${ad} zaman aşımı`); })]);

// Torrentio tracker vermiyor: sunucunun kullandığı ek tracker listesi (data/trackerlar.json, 20 tane).
async function trackerlar() {
  const dosya = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..', '..', 'data', 'trackerlar.json');
  return JSON.parse(fs.readFileSync(dosya, 'utf8')).liste;
}

// Ortak ölçüm: oku(baş, son) -> async iterable Buffer parçaları; peer() -> sayı.
async function olc({ boyut, oku, peer }) {
  const sonuc = { acilis: null, hizMbps: null, sarma: null, peer: 0 };
  const peerTakip = setInterval(() => { sonuc.peer = Math.max(sonuc.peer, peer() || 0); }, 1000);
  try {
    // açılış: ilk 2 MB
    let t0 = Date.now();
    let n = 0;
    for await (const p of oku(0, ILK - 1)) { n += p.length; if (n >= ILK) break; }
    sonuc.acilis = sure(t0);
    // izleme: 30 sn sıralı okuma
    t0 = Date.now();
    n = 0;
    const bitis = Date.now() + IZLE_MS;
    for await (const p of oku(ILK, Math.min(boyut - 1, ILK + 3000 * MB))) {
      n += p.length;
      if (Date.now() > bitis) break;
    }
    sonuc.hizMbps = Math.round(((n * 8) / 1e6 / ((Date.now() - t0) / 1000)) * 10) / 10;
    // sarma: %60'tan 2 MB
    const bas = Math.floor(boyut * 0.6);
    t0 = Date.now();
    n = 0;
    for await (const p of oku(bas, bas + ILK - 1)) { n += p.length; if (n >= ILK) break; }
    sonuc.sarma = sure(t0);
  } finally {
    clearInterval(peerTakip);
  }
  return sonuc;
}

// Okumayı kesmek için akışı async iterable olarak sar (break -> destroy).
async function* akis(stream) {
  try {
    for await (const p of stream) yield p;
  } finally {
    stream.destroy?.();
  }
}

async function stremio(d, tr) {
  await fetch(`${STREMIO}/${d.ih}/remove`).catch(() => {});
  await bekle(1500);
  const q = tr.map((t) => `tr=${encodeURIComponent(t)}`).join('&');
  const adres = `${STREMIO}/${d.ih}/${d.idx}?${q}`;
  let boyut = null;
  const oku = async function* (bas, son) {
    const ctrl = new AbortController();
    const res = await fetch(adres, { headers: { range: `bytes=${bas}-${son}` }, signal: ctrl.signal });
    boyut ||= Number(String(res.headers.get('content-range') || '').split('/')[1]) || null;
    try {
      for await (const p of res.body) yield Buffer.from(p);
    } finally {
      ctrl.abort();
    }
  };
  // Boyutu öğrenmek için ilk okuma ölçüme dahil (açılış süresi zaten bunu içeriyor).
  let istat = null;
  const peerOku = setInterval(async () => {
    try { istat = await (await fetch(`${STREMIO}/${d.ih}/stats.json`)).json(); } catch { /* */ }
  }, 1000);
  try {
    const sonuc = await olc({
      get boyut() { return boyut || 1e10; },
      oku,
      peer: () => istat?.peers || 0,
    });
    return sonuc;
  } finally {
    clearInterval(peerOku);
    await fetch(`${STREMIO}/${d.ih}/remove`).catch(() => {});
  }
}

async function tsMotor(d, tr) {
  const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-ts-'));
  const engine = torrentStream(`magnet:?xt=urn:btih:${d.ih}`, { path: klasor, trackers: tr, connections: 80, uploads: 4, dht: true });
  try {
    await zamanla(new Promise((r) => engine.on('ready', r)), ZAMAN_ASIMI, 'metadata');
    const dosya = engine.files[d.idx];
    return await olc({
      boyut: dosya.length,
      oku: (bas, son) => akis(dosya.createReadStream({ start: bas, end: son })),
      peer: () => engine.swarm.wires.length,
    });
  } finally {
    engine.destroy(() => fs.rmSync(klasor, { recursive: true, force: true }));
  }
}

async function wtMotor(d, tr) {
  const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'olc-wt-'));
  const istemci = new WebTorrent({ maxConns: 80 });
  istemci.on('error', () => {});
  try {
    const torrent = istemci.add(`magnet:?xt=urn:btih:${d.ih}`, { path: klasor, announce: tr, deselect: true });
    await zamanla(new Promise((r) => torrent.on('ready', r)), ZAMAN_ASIMI, 'metadata');
    const dosya = torrent.files[d.idx];
    return await olc({
      boyut: dosya.length,
      oku: (bas, son) => akis(dosya.createReadStream({ start: bas, end: son })),
      peer: () => torrent.numPeers,
    });
  } finally {
    await new Promise((r) => istemci.destroy(r));
    fs.rmSync(klasor, { recursive: true, force: true });
  }
}

const MOTORLAR = { stremio, 'torrent-stream': tsMotor, webtorrent: wtMotor };

const tablo = [];
for (let i = 0; i < DENEMELER.length; i++) {
  const d = DENEMELER[i];
  const tr = await trackerlar(d);
  console.log(`\n== ${d.ad} (${tr.length} tracker)`);
  for (const ad of SIRALAR[i]) {
    const t0 = Date.now();
    let sonuc;
    try {
      sonuc = await zamanla(MOTORLAR[ad](d, tr), ZAMAN_ASIMI + IZLE_MS + 60_000, ad);
    } catch (err) {
      sonuc = { hata: err.message };
    }
    console.log(`  ${ad.padEnd(15)} açılış ${sonuc.acilis ?? '-'} sn | izleme ${sonuc.hizMbps ?? '-'} Mbps | sarma ${sonuc.sarma ?? '-'} sn | peer ${sonuc.peer ?? '-'}${sonuc.hata ? ` | HATA ${sonuc.hata}` : ''} (${sure(t0)} sn)`);
    tablo.push({ torrent: d.ad, motor: ad, ...sonuc });
    await bekle(3000);
  }
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), 'sonuc.json'), JSON.stringify(tablo, null, 1));
process.exit(0);
