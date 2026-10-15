import test from 'node:test';
import assert from 'node:assert/strict';
import { indirmeSec } from '../public/js/shared/kaynak-sec.js';

const s = (o) => ({ kind: 'torrent', seeders: 50, ...o });

test('indirmeSec: kalite, HDR ve Blu-ray süzgeçleri', () => {
  const liste = [
    s({ streamId: 'a', quality: '1080p', source: 'WEB', sizeBytes: 3e9 }),
    s({ streamId: 'b', quality: '1080p', source: 'BluRay', sizeBytes: 9e9, seeders: 20 }),
    s({ streamId: 'c', quality: '2160p', source: 'BluRay', hdr: 'HDR', sizeBytes: 30e9 }),
  ];
  assert.equal(indirmeSec(liste, { kalite: '1080p', bluray: 'olsun' }).secilen.streamId, 'b');
  assert.equal(indirmeSec(liste, { hdr: 'olsun' }).secilen.streamId, 'c');
  assert.equal(indirmeSec(liste, { kalite: '1080p', bluray: 'olmasin' }).secilen.streamId, 'a');
});

test('indirmeSec: boyut en küçük / en büyük / üst sınır', () => {
  const liste = [
    s({ streamId: 'k', quality: '1080p', sizeBytes: 2e9, seeders: 10 }),
    s({ streamId: 'b', quality: '1080p', sizeBytes: 12e9, seeders: 80 }),
  ];
  assert.equal(indirmeSec(liste, { boyut: 'kucuk' }).secilen.streamId, 'k');
  assert.equal(indirmeSec(liste, { boyut: 'buyuk' }).secilen.streamId, 'b');
  assert.equal(indirmeSec(liste, { boyutMaxGb: 5 }).secilen.streamId, 'k');
  assert.equal(indirmeSec(liste, {}).secilen.streamId, 'b'); // fark etmez: en çok kaynaklı
});

test('indirmeSec: eşleşen yoksa süzgeç gevşer ve söylenir', () => {
  const liste = [s({ streamId: 'a', quality: '1080p' })];
  const r = indirmeSec(liste, { dil: 'tr', trAltyazi: 'olsun' });
  assert.equal(r.secilen.streamId, 'a');
  assert.deepEqual(r.gevsetilen, ['Türkçe altyazı', 'dil']);
});

test('indirmeSec: Türkçe altyazı ve dil', () => {
  const liste = [
    s({ streamId: 'x', quality: '1080p', embeddedSubs: { langs: ['Türkçe'] }, seeders: 10 }),
    s({ streamId: 'y', quality: '1080p', turkceSes: true, seeders: 10 }),
    s({ streamId: 'z', quality: '1080p', seeders: 90 }),
  ];
  assert.equal(indirmeSec(liste, { trAltyazi: 'olsun' }).secilen.streamId, 'x');
  assert.equal(indirmeSec(liste, { dil: 'tr' }).secilen.streamId, 'y');
});

test('indirmeSec: istenen dil (favori diller arasından)', () => {
  const liste = [
    s({ streamId: 'e', quality: '1080p', diller: ['en'], seeders: 90 }),
    s({ streamId: 'd', quality: '1080p', diller: ['de'], seeders: 10 }),
  ];
  assert.equal(indirmeSec(liste, { dil: 'de' }).secilen.streamId, 'd');
  assert.equal(indirmeSec(liste, { dil: 'en' }).secilen.streamId, 'e');
  assert.equal(indirmeSec(liste, { dil: 'fr' }).secilen.streamId, 'e'); // yok: gevşer
});

test('indirmeSec: birden çok dil seçilebilir (en az biri yeter)', () => {
  const liste = [
    s({ streamId: 'e', quality: '1080p', diller: ['en'], seeders: 20 }),
    s({ streamId: 'd', quality: '1080p', diller: ['de'], seeders: 90 }),
    s({ streamId: 't', quality: '1080p', diller: ['tr'], seeders: 50 }),
  ];
  assert.equal(indirmeSec(liste, { diller: ['tr', 'en'] }).secilen.streamId, 't'); // tr+en içinde en çok kaynaklı
  assert.equal(indirmeSec(liste, { diller: ['de', 'tr'] }).secilen.streamId, 'd');
  assert.equal(indirmeSec(liste, { diller: [] }).secilen.streamId, 'd'); // seçim yok: fark etmez
});
