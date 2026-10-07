import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKaynakHafiza } from '../src/kaynak-hafiza.js';

const sessiz = { info() {}, warn() {}, error() {} };
const gecici = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kaynak-hafiza-')), 'kaynak-hafiza.json');
const kaynak = (ih, ad) => ({ infoHash: ih.repeat(40).slice(0, 40), title: ad, addonName: 'Torrentio', quality: '1080p' });

test('Kaynak hafızası: grup iyi/kötü sayıları bütün içeriklerde, torrent başına bir kez; dosyadan geri okunur', () => {
  const file = gecici();
  const h = createKaynakHafiza({ file, log: sessiz });
  const a = kaynak('a', 'Film.2024.1080p.WEB-DL-FLUX.mkv');
  h.iyi('tt1', a); // film: dizi kaydı yok ama grup sayılıyor
  h.iyi('tt1', a); // aynı torrent ikinci kez sayılmaz
  h.iyi('tt2:1:1', kaynak('b', 'Dizi.S01E01.1080p-FLUX.mkv'));
  h.kotu(kaynak('c', 'Dizi.S01E02.2160p-KOTUGRUP.mkv'));
  const o = h.ozet();
  assert.deepEqual(o.gruplar.FLUX, { iyi: 2, kotu: 0 });
  assert.deepEqual(o.gruplar.KOTUGRUP, { iyi: 0, kotu: 1 });
  assert.deepEqual(o.kotu, ['c'.repeat(40)]);
  assert.equal(h.oku('tt2:1:5').grup, 'FLUX');
  assert.equal(h.oku('tt1'), null);
  assert.equal(h.oku('_gruplar'), null);
  const yeni = createKaynakHafiza({ file, log: sessiz });
  assert.deepEqual(yeni.ozet().gruplar.FLUX, { iyi: 2, kotu: 0 });
});

test('Kaynak hafızası: kötü işaretlenen torrent sonra iyi indirirse kötü listesinden çıkar', () => {
  const h = createKaynakHafiza({ file: gecici(), log: sessiz });
  const s = kaynak('d', 'Dizi.S01E03.1080p-NTB.mkv');
  h.kotu(s);
  assert.deepEqual(h.ozet().kotu, [s.infoHash]);
  h.iyi('tt3:1:3', s);
  assert.deepEqual(h.ozet().kotu, []);
});
