// İndirilen dosya motor taklidinden diskten servis ediliyor mu? (TorrServer olmadan)
// Oda, relay, masaüstü mpv ve telefon hep aynı adresi istiyor: bu yol çalışıyorsa
// hiçbiri değişmeden indirilen kopyadan oynatıyor.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createIndirme } from '../src/indirme.js';
import { createStremioTaklidi } from '../src/motor/stremio-taklidi.js';

const IH = 'b'.repeat(40);
const sessiz = { info() {}, warn() {}, error() {} };
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function hazirla(icerik) {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-servis-'));
  const indirme = createIndirme({
    dataDir: dizin,
    log: sessiz,
    istek: async (adres, bas, son) => ({
      akis: Readable.from([icerik.subarray(bas, Math.min(icerik.length, son + 1))]),
      toplam: icerik.length,
    }),
  });
  indirme.ekle({ infoHash: IH, fileIdx: 0, filename: 'Film.mkv', ad: 'Film', boyut: icerik.length });
  for (let i = 0; i < 300; i += 1) {
    if (indirme.liste()[0]?.durum === 'bitti') break;
    await bekle(10);
  }
  assert.equal(indirme.liste()[0].durum, 'bitti');

  // TorrServer bilerek kapalı: dosya diskte olduğu için ona hiç gidilmemeli.
  const taklit = createStremioTaklidi({
    ts: {
      akisAdresi: () => 'http://127.0.0.1:1/yok',
      async ekle() { throw new Error('TorrServer çağrılmamalı'); },
      async dosyalar() { throw new Error('TorrServer çağrılmamalı'); },
    },
    port: 0,
    log: sessiz,
    indirme,
  });
  await taklit.baslat();
  const port = taklit.port?.() ?? taklit.adres?.().port;
  return { dizin, indirme, taklit, port };
}

function iste(port, yol, basliklar = {}) {
  return new Promise((coz, red) => {
    const r = http.get({ host: '127.0.0.1', port, path: yol, headers: basliklar }, (yanit) => {
      const parcalar = [];
      yanit.on('data', (p) => parcalar.push(p));
      yanit.on('end', () => coz({ kod: yanit.statusCode, basliklar: yanit.headers, govde: Buffer.concat(parcalar) }));
    });
    r.on('error', red);
  });
}

test('indirilen dosya diskten servis ediliyor (TorrServer\'a gidilmiyor)', async () => {
  const icerik = Buffer.from(Array.from({ length: 20_000 }, (_, i) => i % 251));
  const { dizin, indirme, taklit, port } = await hazirla(icerik);
  try {
    const tam = await iste(port, `/${IH}/0?f=Film.mkv`);
    assert.equal(tam.kod, 200);
    assert.equal(tam.basliklar['content-type'], 'video/x-matroska');
    assert.equal(tam.basliklar['accept-ranges'], 'bytes');
    assert.ok(tam.govde.equals(icerik), 'içerik birebir');

    const aralik = await iste(port, `/${IH}/0?f=Film.mkv`, { range: 'bytes=100-199' });
    assert.equal(aralik.kod, 206);
    assert.equal(aralik.basliklar['content-range'], `bytes 100-199/${icerik.length}`);
    assert.ok(aralik.govde.equals(icerik.subarray(100, 200)));

    // "Son N bayt" (mpv/MKV dizini için): oynatıcılar bunu istiyor.
    const son = await iste(port, `/${IH}/0?f=Film.mkv`, { range: 'bytes=-50' });
    assert.equal(son.kod, 206);
    assert.ok(son.govde.equals(icerik.subarray(icerik.length - 50)));

    // Dosya sonunu aşan aralık: 416.
    const asan = await iste(port, `/${IH}/0?f=Film.mkv`, { range: `bytes=${icerik.length + 10}-` });
    assert.equal(asan.kod, 416);

    // HEAD: boyut bilgisi, gövde yok.
    const head = await new Promise((coz, red) => {
      const r = http.request({ host: '127.0.0.1', port, path: `/${IH}/0?f=Film.mkv`, method: 'HEAD' }, (y) => {
        y.resume();
        y.on('end', () => coz({ kod: y.statusCode, uzunluk: y.headers['content-length'] }));
      });
      r.on('error', red);
      r.end();
    });
    assert.equal(head.kod, 200);
    assert.equal(head.uzunluk, String(icerik.length));
  } finally {
    taklit.durdur();
    indirme.durdur();
    await bekle(30);
    fs.rmSync(dizin, { recursive: true, force: true });
  }
});

test('indirilmemiş dosyada motora gidiliyor (çökmüyor)', async () => {
  const icerik = Buffer.from('x'.repeat(100));
  const { dizin, indirme, taklit, port } = await hazirla(icerik);
  try {
    const yok = await iste(port, `/${'c'.repeat(40)}/0`);
    // TorrServer kapalı olduğu için hata kodu dönüyor; önemli olan sunucunun ayakta kalması.
    assert.ok(yok.kod >= 500, `durum ${yok.kod}`);
    const tam = await iste(port, `/${IH}/0?f=Film.mkv`);
    assert.equal(tam.kod, 200, 'sunucu hâlâ çalışıyor');
  } finally {
    taklit.durdur();
    indirme.durdur();
    await bekle(30);
    fs.rmSync(dizin, { recursive: true, force: true });
  }
});

test('dosya silinince motora dönülüyor', async () => {
  const icerik = Buffer.from('y'.repeat(500));
  const { dizin, indirme, taklit, port } = await hazirla(icerik);
  try {
    assert.equal((await iste(port, `/${IH}/0?f=Film.mkv`)).kod, 200);
    fs.rmSync(indirme.hazirDosya(IH, 0).yol);
    // Kayıt duruyor ama dosya yok: taklit artık diskten veremez, motora gider (kapalı → hata).
    assert.ok((await iste(port, `/${IH}/0?f=Film.mkv`)).kod >= 500);
  } finally {
    taklit.durdur();
    indirme.durdur();
    await bekle(30);
    fs.rmSync(dizin, { recursive: true, force: true });
  }
});
