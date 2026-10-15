import test from 'node:test';
import assert from 'node:assert/strict';
import { magnetCoz, baslikTahmin, videoMu } from '../src/magnet-coz.js';

const IH = 'cf667a7b14f365fb03d5b028f9589dadc36f69f2';

test('magnetCoz: hex btih, ad ve tracker\'lar', () => {
  const r = magnetCoz(`magnet:?xt=urn:btih:${IH.toUpperCase()}&dn=Severance.S02E02.2160p&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=udp%3A%2F%2Ftracker.example%3A1337%2Fannounce&tr=javascript%3Aalert(1)`);
  assert.equal(r.infoHash, IH);
  assert.equal(r.ad, 'Severance.S02E02.2160p');
  assert.deepEqual(r.trackerlar, ['udp://tracker.example:1337/announce']); // tekil, yalnız ağ adresleri
});

test('magnetCoz: base32 btih hex\'e çevriliyor', () => {
  // 20 bayt = 32 base32 karakter. Hex 'cf66...'in base32 karşılığı:
  const bayt = Buffer.from(IH, 'hex');
  const alfabe = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of bayt) bits += b.toString(2).padStart(8, '0');
  let b32 = '';
  for (let i = 0; i < bits.length; i += 5) b32 += alfabe[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  assert.equal(b32.length, 32);
  assert.equal(magnetCoz(`magnet:?xt=urn:btih:${b32}`).infoHash, IH);
});

test('magnetCoz: geçersizler null', () => {
  assert.equal(magnetCoz('merhaba'), null);
  assert.equal(magnetCoz('magnet:?dn=sadece-ad'), null);
  assert.equal(magnetCoz('magnet:?xt=urn:btih:kisa'), null);
  assert.equal(magnetCoz(''), null);
});

test('baslikTahmin: dizi bölümü', () => {
  assert.deepEqual(baslikTahmin('Severance.S02E02.Goodbye.Mrs.Selvig.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.HEVC-FLUX'),
    { sorgu: 'Severance', yil: null, sezon: 2, bolum: 2 });
});

test('baslikTahmin: film + yıl', () => {
  assert.deepEqual(baslikTahmin('The.Matrix.1999.1080p.BluRay.x264-GRP'), { sorgu: 'The Matrix', yil: 1999, sezon: null, bolum: null });
  assert.deepEqual(baslikTahmin('Spider-Man.Brand.New.Day.2026.2160p.WEB-DL'), { sorgu: 'Spider-Man Brand New Day', yil: 2026, sezon: null, bolum: null });
});

test('baslikTahmin: sezon paketi (bölüm yok) ve yıl olmadan', () => {
  const r = baslikTahmin('Silo S03 COMPLETE 1080p WEB-DL');
  assert.equal(r.sorgu, 'Silo');
  assert.equal(r.sezon, 3);
  assert.equal(r.bolum, null);
  assert.equal(baslikTahmin('Bir Film Adi 720p').sorgu, 'Bir Film Adi');
});

test('baslikTahmin: başlıktaki yıl (2001: Bir Uzay Destanı) bozulmuyor', () => {
  assert.equal(baslikTahmin('2001.A.Space.Odyssey.1968.1080p').sorgu, '2001 A Space Odyssey');
});

test('videoMu', () => {
  assert.equal(videoMu('a/b/Film.MKV'), true);
  assert.equal(videoMu('altyazi.srt'), false);
});
