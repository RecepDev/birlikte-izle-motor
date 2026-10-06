import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { dosyaSec, istatistik, opensubHash, createStremioTaklidi } from '../src/motor/stremio-taklidi.js';

const sessiz = { info() {}, warn() {}, error() {} };
const IH = 'ab'.repeat(20);

test('dosyaSec: Torrentio sırası dolgu dosyaları yüzünden kayınca dosya adıyla eşleşir', () => {
  // Ölçümde görülen: Torrentio fileIdx 4, TorrServer'da (dolgu dosyaları yok) 2 numara.
  const dosyalar = [
    { id: 1, length: 143111, path: 'Film/NH.png' },
    { id: 2, length: 23577636452, path: 'Film/Film.2160p.mkv' },
    { id: 3, length: 38, path: 'Film/a.txt' },
    { id: 4, length: 64, path: 'Film/b.txt' },
    { id: 5, length: 406, path: 'Film/info.txt' },
  ];
  assert.equal(dosyaSec(dosyalar, 4, 'Film.2160p.mkv').id, 2);
  // Ad yok, sıra video olmayan bir dosyaya denk geliyor: en büyük video.
  assert.equal(dosyaSec(dosyalar, 4, null).id, 2);
  assert.equal(dosyaSec(dosyalar, -1, null).id, 2);
});

test('dosyaSec: sezon paketinde ad yoksa sıradaki video seçilir', () => {
  const dosyalar = [
    { id: 1, length: 900, path: 'S01/E01.mkv' },
    { id: 2, length: 1000, path: 'S01/E02.mkv' },
    { id: 3, length: 950, path: 'S01/E03.mkv' },
  ];
  assert.equal(dosyaSec(dosyalar, 0, null).id, 1);
  assert.equal(dosyaSec(dosyalar, 2, 'E03.mkv').id, 3);
});

test('istatistik: TorrServer durumu Stremio stats.json biçimine çevrilir', () => {
  const s = istatistik({ hash: IH, active_peers: 12, total_peers: 40, download_speed: 1_250_000, bytes_written_data: 5000 });
  assert.equal(s.peers, 12);
  assert.equal(s.swarmSize, 40);
  assert.equal(s.downloadSpeed, 1_250_000);
  assert.equal(s.uploaded, 5000);
  assert.deepEqual(s.selections, []);
  assert.equal(istatistik(null), null);
});

test('opensubHash: boyut + ilk/son 64 KB toplamı, 16 hane', () => {
  const bas = Buffer.alloc(65536);
  const son = Buffer.alloc(65536);
  bas.writeBigUInt64LE(1n, 0);
  son.writeBigUInt64LE(0xffffffffffffffffn, 0); // taşma mod 2^64
  assert.equal(opensubHash(200000, bas, son), (200000n).toString(16).padStart(16, '0'));
});

test('Stremio taklidi: stats, akış (Range), kapatma, ekleme', async () => {
  const veri = Buffer.from('0123456789abcdefghij');
  const kaynak = http.createServer((req, res) => {
    const [a, b] = String(req.headers.range || 'bytes=0-').slice(6).split('-').map((x) => (x === '' ? null : Number(x)));
    const son = b ?? veri.length - 1;
    res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${a}-${son}/${veri.length}`, 'content-length': son - a + 1 });
    res.end(veri.subarray(a, son + 1));
  });
  await new Promise((r) => kaynak.listen(0, '127.0.0.1', r));
  const olaylar = [];
  let acik = false;
  const ts = {
    async torrent(ih) {
      return acik && ih === IH ? { hash: IH, active_peers: 3, download_speed: 100, file_stats: [{ id: 1, length: 20, path: 'x/film.mkv' }] } : null;
    },
    async torrentler() { return acik ? [await this.torrent(IH)] : []; },
    async ekle(ih, tr) { olaylar.push(['ekle', ih, tr]); acik = true; },
    async kapat(ih) { olaylar.push(['kapat', ih]); acik = false; },
    akisAdresi: (ih, id) => `http://127.0.0.1:${kaynak.address().port}/stream?link=${ih}&index=${id}`,
  };
  const taklit = createStremioTaklidi({ ts, port: 0, log: sessiz });
  await taklit.baslat();
  const adres = `http://127.0.0.1:${taklit.port()}`;
  try {
    assert.equal((await fetch(`${adres}/settings`)).status, 200);
    assert.equal(await (await fetch(`${adres}/${IH}/stats.json`)).json(), null);
    // Akış torrent'i tracker'larıyla açar ("tracker:" öneki atılır, dht: yok sayılır).
    const tr = `tr=${encodeURIComponent('tracker:udp://t:1')}&tr=${encodeURIComponent(`dht:${IH}`)}`;
    const res = await fetch(`${adres}/${IH}/0?${tr}`, { headers: { range: 'bytes=5-9' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 5-9/20');
    assert.equal(await res.text(), '56789');
    assert.deepEqual(olaylar[0], ['ekle', IH, ['udp://t:1']]);
    const st = await (await fetch(`${adres}/${IH}/stats.json`)).json();
    assert.equal(st.peers, 3);
    assert.deepEqual(Object.keys(await (await fetch(`${adres}/stats.json`)).json()), [IH]);
    await fetch(`${adres}/${IH}/remove`);
    assert.deepEqual(olaylar.at(-1), ['kapat', IH]);
    await fetch(`${adres}/${IH}/create`, { method: 'POST', body: JSON.stringify({ torrent: { infoHash: IH }, peerSearch: { sources: ['tracker:udp://u:2'] } }) });
    assert.deepEqual(olaylar.at(-1), ['ekle', IH, ['udp://u:2']]);
    assert.equal((await fetch(`${adres}/hlsv2/x/master.m3u8`)).status, 404);
  } finally {
    taklit.durdur();
    kaynak.close();
  }
});

test('Önbellek: izlenen yer diske yazılır, TorrServer kapalıyken de diskten gelir', async () => {
  const { createOnbellek } = await import('../src/motor/onbellek.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'onbellek-'));
  const veri = Buffer.from('0123456789abcdefghij'); // 20 bayt, blok 4 bayt: 5 blok
  let istek = 0;
  const kaynak = http.createServer((req, res) => {
    istek++;
    const [a, b] = String(req.headers.range).slice(6).split('-').map(Number);
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${veri.length}` });
    res.end(veri.subarray(a, b + 1));
  });
  await new Promise((r) => kaynak.listen(0, '127.0.0.1', r));
  const ts = {
    async torrent() { return { hash: IH, file_stats: [{ id: 1, length: 20, path: 'x/film.mkv' }] }; },
    async ekle() {},
    akisAdresi: () => `http://127.0.0.1:${kaynak.address().port}/`,
  };
  const onbellek = createOnbellek({ klasor, blok: 4, log: sessiz });
  const taklit = createStremioTaklidi({ ts, port: 0, log: sessiz, onbellek });
  await taklit.baslat();
  const adres = `http://127.0.0.1:${taklit.port()}/${IH}/0`;
  try {
    const ilk = await fetch(adres, { headers: { range: 'bytes=0-19' } });
    assert.equal(await ilk.text(), veri.toString());
    assert.equal(istek, 1);
    await new Promise((r) => setTimeout(r, 200)); // bloklar arkada yazılıyor
    kaynak.close(); // TorrServer yok
    const ikinci = await fetch(adres, { headers: { range: 'bytes=5-14' } });
    assert.equal(ikinci.status, 206);
    assert.equal(ikinci.headers.get('content-range'), 'bytes 5-14/20');
    assert.equal(await ikinci.text(), '56789abcde');
    assert.equal(istek, 1, 'ikinci okuma internete/TorrServer\'a gitmedi');
    // Sınır: en uzun süredir kullanılmayan bloklar silinir.
    const kucuk = createOnbellek({ klasor, sinirBayt: 8, blok: 4, log: sessiz });
    const sonuc = await kucuk.temizle();
    assert.ok(sonuc.toplam <= 8);
  } finally {
    taklit.durdur();
    kaynak.close();
    fs.rmSync(klasor, { recursive: true, force: true });
  }
});
