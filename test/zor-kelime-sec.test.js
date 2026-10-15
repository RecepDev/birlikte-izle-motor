import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecici, ozelAdlariBul } from '../public/js/shared/zor-kelime-sec.js';
import { kokAdaylari } from '../public/js/shared/kelime-kok.js';

// Küçük bir sözlük: r = sıklık sırası (küçük = sık), a = anlamlar.
const VERI = {
  siraSiniri: 8000,
  kelime: {
    the: { r: 2 }, you: { r: 0 }, and: { r: 10 }, house: { r: 300, a: [['isim', 'ev', 'hane']] },
    run: { r: 420, a: [['fiil', 'koşmak'], ['isim', 'koşu']] },
    hold: { r: 500, a: [['fiil', 'tutmak']] },
    cunning: { r: 4821, a: [['isim', 'kurnazlık', 'cerbeze'], ['sıfat', 'kurnaz']] },
    vengeance: { r: 6200, a: [['isim', 'intikam']] },
    consigliere: { a: [['isim', 'danışman']] }, // listede yok: en seyrek
    honor: { r: 2400, a: [['isim', 'onur', 'şeref']] },
    teach: { r: 1900, a: [['fiil', 'öğretmek']] },
    wolf: { r: 3800, a: [['isim', 'kurt']] },
    undertake: { r: 7000, a: [['fiil', 'girişmek']] },
  },
};

test('kokAdaylari çekim eklerini atar, yapım eklerini atmaz', () => {
  assert.ok(kokAdaylari('houses').includes('house'));
  assert.ok(kokAdaylari('running').includes('run'));
  assert.ok(kokAdaylari('held').includes('hold'), 'düzensiz fiil');
  assert.ok(kokAdaylari('wolves').includes('wolf'), 'düzensiz çoğul');
  assert.ok(kokAdaylari('honoured').includes('honored'), 'İngiliz yazımı');
  assert.ok(kokAdaylari('taught').includes('teach'));
  // Yapım eki atılmıyor: "undertaker" için "undertake" karşılığı yanlış olurdu.
  assert.ok(!kokAdaylari('undertaker').includes('undertake'));
});

test('seviyeye göre kolay/zor ayrımı', () => {
  const s = createSecici(VERI, 2000);
  assert.equal(s.kolay('the'), true);
  assert.equal(s.kolay('house'), true);
  assert.equal(s.kolay('houses'), true, 'çekimli biçim de kolay');
  assert.equal(s.kolay('cunning'), false);
  assert.equal(s.kolay('consigliere'), false, 'listede olmayan kelime zor');
  // Seviye yükselince orta sıklıktakiler de kolay sayılıyor.
  const ileri = createSecici(VERI, 5000);
  assert.equal(ileri.kolay('cunning'), true);
  assert.equal(ileri.kolay('vengeance'), false);
});

test('zorlar: repliğin zor kelimelerini seyrekten sık sıraya verir', () => {
  const s = createSecici(VERI, 2000);
  const sonuc = s.zorlar('His cunning was no match for our vengeance.\nThe consigliere knew.');
  assert.deepEqual(sonuc.map((x) => x.kelime), ['consigliere', 'vengeance', 'cunning']);
  assert.deepEqual(sonuc[2].anlamlar[0], ['isim', 'kurnazlık', 'cerbeze']);
});

test('zorlar: en fazla 3 satır', () => {
  const s = createSecici(VERI, 1000);
  const sonuc = s.zorlar('cunning vengeance consigliere honor wolf undertake');
  assert.equal(sonuc.length, 3);
});

test('karşılığı olmayan kelime kutuya girmiyor', () => {
  const s = createSecici(VERI, 2000);
  // "zyzzyva" sözlükte yok: zor ama gösterilecek bir şey yok.
  assert.deepEqual(s.zorlar('A zyzzyva appeared.'), []);
});

test('özel adlar ve kısaltmalar atlanıyor', () => {
  const veri = { kelime: { ...VERI.kelime, sollozzo: { a: [['isim', 'ad']] } } };
  const s = createSecici(veri, 2000);
  // Satır içindeki büyük harfli kelime özel ad sayılıyor.
  assert.deepEqual(s.zorlar('I saw Sollozzo there.'), []);
  // Satır başındaki büyük harf cümle başı olabilir: alınıyor.
  assert.deepEqual(s.zorlar('Cunning wins.').map((x) => x.kelime), ['Cunning']);
  // Kısaltmalar: I'm, he'll...
  assert.deepEqual(s.zorlar("I'm fine, he'll come.").map((x) => x.kelime), []);
});

test('iyelik eki temizleniyor', () => {
  const s = createSecici(VERI, 2000);
  assert.deepEqual(s.zorlar("The cunning's edge.").map((x) => x.kok), ['cunning']);
});

test('aynı kelime iki kez geçerse bir kez yazılıyor', () => {
  const s = createSecici(VERI, 2000);
  assert.equal(s.zorlar('cunning and cunning again').length, 1);
});

test('çekimli zor kelime kök karşılığıyla bulunuyor', () => {
  const s = createSecici(VERI, 1000);
  const sonuc = s.zorlar('They were undertaking vengeances.');
  const kokler = sonuc.map((x) => x.kok);
  assert.ok(kokler.includes('vengeance'), 'vengeances -> vengeance');
  assert.ok(kokler.includes('undertake'), 'undertaking -> undertake (çekim eki)');
});

test('boş metin ve veri yokluğu çökmüyor', () => {
  assert.deepEqual(createSecici(VERI, 2000).zorlar(''), []);
  assert.deepEqual(createSecici(null, 2000).zorlar('cunning'), []);
  assert.deepEqual(createSecici({}, 2000).zorlar('cunning'), []);
});

test('seviyeSec sonradan değiştirilebiliyor', () => {
  const s = createSecici(VERI, 2000);
  assert.equal(s.zorlar('cunning').length, 1);
  s.seviyeSec(5000);
  assert.equal(s.seviye(), 5000);
  assert.equal(s.zorlar('cunning').length, 0, 'ileri seviyede artık zor değil');
});

// ---- filmin özel adları --------------------------------------------------------------

test('ozelAdlariBul: hiç küçük harfle geçmeyen kelimeleri özel ad sayar', () => {
  const replikler = [
    'Sollozzo is coming.',
    'I told Sollozzo no.',
    'The wall is high.',
    'Wall of silence, the kind that kills.', // satır başında büyük: ama küçük harfle de geçiyor
  ];
  const adlar = ozelAdlariBul(replikler);
  assert.ok(adlar.has('sollozzo'));
  assert.ok(!adlar.has('wall'), 'küçük harfle de geçen kelime özel ad değil');
  assert.ok(!adlar.has('the'), 'küçük harfle de geçiyor');
  // Not: küçük bir örnekte yalnız büyük harfle geçen sık kelimeler de listeye
  // girebilir; zararsız, çünkü onlar zaten "kolay" sayılıp kutuya girmiyor.
});

test('özel adlar kutuya girmiyor (satır başında olsalar bile)', () => {
  const veri = { kelime: { ...VERI.kelime, dufresne: { a: [['isim', 'soyadı']] } } };
  const adlar = ozelAdlariBul(['Dufresne walked.', 'I saw Dufresne.']);
  const s = createSecici(veri, 2000, { ozelAdlar: adlar });
  // Satır başındaki büyük harf eskiden cümle başı sayılıp kutuya giriyordu.
  assert.deepEqual(s.zorlar('Dufresne vengeance.').map((x) => x.kok), ['vengeance']);
  // Liste verilmezse eski davranış: sıralaması olmayan ad en seyrek sayılıp öne geçer.
  const adsiz = createSecici(veri, 2000);
  assert.deepEqual(adsiz.zorlar('Dufresne vengeance.').map((x) => x.kok), ['dufresne', 'vengeance']);
});

test('özel ad listesi dizi olarak da verilebiliyor', () => {
  const s = createSecici(VERI, 2000, { ozelAdlar: ['cunning'] });
  assert.deepEqual(s.zorlar('Cunning vengeance.').map((x) => x.kok), ['vengeance']);
});
