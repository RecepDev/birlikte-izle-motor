import test from 'node:test';
import assert from 'node:assert/strict';
import { createTakilmaOlcer } from '../public/js/shared/takilma-olc.js';

// Yardımcı: 200 ms'de bir örnek veren bir oynatma akışı kurar.
function akis(olcer, adimlar, { hiz = 1, beklemede = false } = {}) {
  let t = 10_000;
  let konum = 100;
  const sonuclar = [];
  for (const ilerleme of adimlar) {
    t += 200;
    konum += ilerleme;
    sonuclar.push(olcer.ol(konum, beklemede, hiz, t));
  }
  return sonuclar.filter(Boolean);
}

test('düzgün oynarken hiçbir şey bildirmez', () => {
  const olcer = createTakilmaOlcer();
  assert.deepEqual(akis(olcer, Array(20).fill(0.2)), []);
});

test('bir saniyelik donmayı yakalar ve süresini verir', () => {
  const olcer = createTakilmaOlcer();
  // 5 örnek (1 sn) boyunca konum ilerlemiyor, sonra normale dönüyor.
  const sonuc = akis(olcer, [0.2, 0.2, 0, 0, 0, 0, 0, 0.2, 0.2]);
  assert.equal(sonuc.length, 1);
  assert.ok(Math.abs(sonuc[0].sure - 1) < 0.01, `süre ${sonuc[0].sure}`);
});

test('eşiğin altındaki tek örnek kaybını bildirmez', () => {
  const olcer = createTakilmaOlcer();
  // 200 ms'lik tek bir aksama (0,2 sn kayıp) gürültüdür, kayda değmez.
  assert.deepEqual(akis(olcer, [0.2, 0.2, 0, 0.2, 0.2]), []);
});

test('duraklatılmışken ölçmez', () => {
  const olcer = createTakilmaOlcer();
  assert.deepEqual(akis(olcer, Array(10).fill(0), { beklemede: true }), []);
});

test('duraklatma donmayı sıfırlar, araya karışmaz', () => {
  const olcer = createTakilmaOlcer();
  let t = 10_000;
  // Donma başlıyor...
  assert.equal(olcer.ol(100, false, 1, t += 200), null);
  assert.equal(olcer.ol(100, false, 1, t += 200), null);
  assert.equal(olcer.ol(100, false, 1, t += 200), null);
  // ...ama kişi duraklattı: biriken kayıp atılıyor.
  assert.equal(olcer.ol(100, true, 1, t += 200), null);
  assert.equal(olcer.ol(100, false, 1, t += 200), null);
  assert.equal(olcer.ol(100.2, false, 1, t += 200), null);
});

test('yavaş/hızlı oynatmada beklenen ilerleme hıza göre', () => {
  const yavas = createTakilmaOlcer();
  // 0,95x hızda 200 ms'de 0,19 sn ilerliyor: donma yok.
  assert.deepEqual(akis(yavas, Array(10).fill(0.19), { hiz: 0.95 }), []);
  const hizli = createTakilmaOlcer();
  // 1,05x bekleniyorken 0,1 ilerleme = donma (senkron yakalarken takılma sayılır).
  const sonuc = akis(hizli, [0.21, 0.21, 0, 0, 0, 0, 0, 0.21, 0.21], { hiz: 1.05 });
  assert.equal(sonuc.length, 1);
  assert.ok(sonuc[0].sure > 1);
});

test('aynı okuma iki kez gelirse ölçüme girmez', () => {
  const olcer = createTakilmaOlcer();
  assert.equal(olcer.ol(100, false, 1, 5000), null);
  // Masaüstünde durum 200 ms'de bir yenilenir, sayfa 400 ms'de bir bakar: aynı t
  // ile gelen örnek "ilerlemedi" sayılmamalı.
  assert.equal(olcer.ol(100, false, 1, 5000), null);
  assert.equal(olcer.ol(100.4, false, 1, 5400), null);
  assert.deepEqual(akis(olcer, Array(8).fill(0.2)), []);
});

test('uzun boşluktan (sekme arkada) sonra sıfırlanır', () => {
  const olcer = createTakilmaOlcer();
  let t = 10_000;
  olcer.ol(100, false, 1, t);
  // 30 saniye sonra gelen örnek: kayıp sayılmaz, ölçüm baştan başlar.
  assert.equal(olcer.ol(130, false, 1, t + 30_000), null);
  assert.deepEqual(akis(olcer, Array(8).fill(0.2)), []);
});

test('sifirla biriken kaybı atar', () => {
  const olcer = createTakilmaOlcer();
  let t = 10_000;
  olcer.ol(100, false, 1, t += 200);
  olcer.ol(100, false, 1, t += 200);
  olcer.ol(100, false, 1, t += 200);
  olcer.sifirla();
  olcer.ol(100, false, 1, t += 200);
  assert.equal(olcer.ol(100.2, false, 1, t += 200), null);
});

test('eşik ayarlanabilir', () => {
  const olcer = createTakilmaOlcer({ esik: 2 });
  // 1,2 sn'lik donma 2 sn eşiğinin altında: bildirilmiyor.
  assert.deepEqual(akis(olcer, [0.2, 0.2, 0, 0, 0, 0, 0, 0.2, 0.2]), []);
});

test('bildirilen konum donmanın bittiği yer', () => {
  const olcer = createTakilmaOlcer();
  const sonuc = akis(olcer, [0.2, 0, 0, 0, 0, 0, 0.2, 0.2]);
  assert.equal(sonuc.length, 1);
  // İlk örnek 100,2'de çapa; beş örnek boyunca donuk; akış dönünce 100,4.
  assert.ok(Math.abs(sonuc[0].konum - 100.4) < 0.05, `konum ${sonuc[0].konum}`);
});
