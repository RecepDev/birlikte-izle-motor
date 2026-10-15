import test from 'node:test';
import assert from 'node:assert/strict';
import { sesDilleri, dilAdi } from '../public/js/shared/diller.js';

test('sesDilleri: bayrak, ad ve kısaltma', () => {
  assert.deepEqual(sesDilleri('Movie 1080p\n🇬🇧 / 🇹🇷'), ['tr', 'en']);
  assert.ok(sesDilleri('Film.GERMAN.DL.1080p').includes('de'));
  assert.ok(sesDilleri('Film Turkish English 1080p').includes('tr'));
});

test('sesDilleri: altyazı dili ses sayılmaz', () => {
  assert.equal(sesDilleri('Film 1080p Türkçe Altyazı').includes('tr'), false);
  assert.equal(sesDilleri('Film 1080p Sub (Eng Tur)').includes('tr'), false);
  assert.equal(dilAdi('tr'), 'Türkçe');
});

test('panel/js/diller.js, paylaşılan diller.js ile aynı (yalnız başlık yorumu farklı)', async () => {
  const fs = await import('node:fs');
  const govde = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n').split('\n').filter((s) => !s.startsWith('// OTOMATİK KOPYA') && !s.startsWith('// yeni bir sunucu yolu')).join('\n');
  assert.equal(govde('../panel/js/diller.js'), govde('../public/js/shared/diller.js'));
});

test('seceneklerDogrula: diller listesi ve eski tek dil', async () => {
  const { seceneklerDogrula } = await import('../src/indirme-secenek.js');
  assert.deepEqual(seceneklerDogrula({ diller: ['tr', 'xx', 'en', 'tr'] }).diller, ['tr', 'en']);
  assert.deepEqual(seceneklerDogrula({ dil: 'turkce' }).diller, ['tr']);
  assert.deepEqual(seceneklerDogrula({}).diller, []);
});
