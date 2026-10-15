import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cueAraliklari, hizalamaPlani, zamanCevir, planUygula, zamanYaz, replikPuan,
} from '../public/js/shared/altyazi-hizala.js';

// Gerçekçi bir altyazı üretir: replikler düzensiz aralıklarla geliyor.
function altyaziUret({ sayi = 300, baslangic = 30, tohum = 1, zamanDonusturucu = (t) => t } = {}) {
  let t = baslangic;
  let x = tohum;
  const rastgele = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const satirlar = ['WEBVTT', ''];
  for (let i = 0; i < sayi; i += 1) {
    t += 1 + rastgele() * 6;
    const sure = 1 + rastgele() * 3;
    satirlar.push(`${zamanYaz(zamanDonusturucu(t))} --> ${zamanYaz(zamanDonusturucu(t + sure))}`);
    satirlar.push(`replik ${i}`, '');
    t += sure;
  }
  return satirlar.join('\n');
}

test('cueAraliklari VTT ve SRT zamanlarını okur', () => {
  const vtt = 'WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nbir\n\n00:01:00.000 --> 00:01:02.250\niki\n';
  assert.deepEqual(cueAraliklari(vtt), [{ b: 1.5, s: 3 }, { b: 60, s: 62.25 }]);
  const srt = '1\n00:00:04,100 --> 00:00:05,200\nüç\n';
  assert.deepEqual(cueAraliklari(srt), [{ b: 4.1, s: 5.2 }]);
});

test('sabit kaymayı bulur', () => {
  const ref = altyaziUret();
  const hedef = altyaziUret({ zamanDonusturucu: (t) => t + 7.3 });
  const plan = hizalamaPlani(ref, hedef);
  assert.equal(plan.ok, true);
  assert.equal(plan.mod, 'sabit');
  assert.ok(plan.guven > 0.95, `güven ${plan.guven}`);
  assert.ok(Math.abs(plan.kaydirma + 7.3) < 0.1, `kaydırma ${plan.kaydirma}`);
  for (const t of [100, 500, 1200]) {
    assert.ok(Math.abs(zamanCevir(plan, t + 7.3) - t) < 0.1);
  }
});

test('kare hızı farkını (23,976 ↔ 25) bulur', () => {
  const ref = altyaziUret();
  const oran = 25 / 23.976;
  const hedef = altyaziUret({ zamanDonusturucu: (t) => t * oran });
  const plan = hizalamaPlani(ref, hedef);
  assert.equal(plan.ok, true);
  assert.equal(plan.mod, 'oranli');
  for (const t of [100, 800, 1500]) {
    assert.ok(Math.abs(zamanCevir(plan, t * oran) - t) < 0.2, `t=${t}`);
  }
});

test('film ortasında değişen kaymayı parçalı düzeltir', () => {
  const ref = altyaziUret({ sayi: 500 });
  const kir = (t) => t + 2 + (t > 900 ? 11 : 0);
  const hedef = altyaziUret({ sayi: 500, zamanDonusturucu: kir });
  const plan = hizalamaPlani(ref, hedef);
  assert.equal(plan.ok, true);
  assert.equal(plan.mod, 'parcali');
  assert.ok(plan.noktalar.length > 1);
  // Kırılmanın iki yanında da doğru olmalı: tek bir gecikme bunu çözemez.
  for (const t of [200, 600, 880, 1000, 1500, 2000]) {
    const bulunan = zamanCevir(plan, kir(t));
    assert.ok(Math.abs(bulunan - t) < 0.5, `t=${t} bulunan=${bulunan.toFixed(2)}`);
  }
});

test('iki kırılmayı birlikte çözer', () => {
  const ref = altyaziUret({ sayi: 600 });
  const kir = (t) => t - 3 + (t > 700 ? 9 : 0) + (t > 1600 ? 6 : 0);
  const hedef = altyaziUret({ sayi: 600, zamanDonusturucu: kir });
  const plan = hizalamaPlani(ref, hedef);
  assert.equal(plan.ok, true);
  for (const t of [300, 650, 800, 1500, 1700, 2500]) {
    assert.ok(Math.abs(zamanCevir(plan, kir(t)) - t) < 0.5, `t=${t}`);
  }
});

test('alakasız iki dosyayı hizalamayı reddeder', () => {
  const ref = altyaziUret({ tohum: 7 });
  const baska = altyaziUret({ tohum: 99, baslangic: 200 });
  const plan = hizalamaPlani(ref, baska);
  assert.equal(plan.ok, false);
  assert.equal(plan.sebep, 'oturmadi');
  assert.ok(plan.guven < 0.35, `güven ${plan.guven}`);
});

test('çok az repliği olan dosyayı reddeder', () => {
  const plan = hizalamaPlani(altyaziUret(), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\ntek\n');
  assert.equal(plan.ok, false);
  assert.equal(plan.sebep, 'azCue');
});

test('zaten uyumlu dosyada kaydırma sıfıra yakın kalır', () => {
  const ref = altyaziUret();
  const plan = hizalamaPlani(ref, ref);
  assert.equal(plan.ok, true);
  assert.ok(Math.abs(plan.kaydirma) < 0.05, `kaydırma ${plan.kaydirma}`);
  assert.equal(plan.guven, 1);
  assert.equal(plan.kesin, true);
});

test('planUygula cue zamanlarını yeniden yazar, metni bozmaz', () => {
  const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000 line:90%\nmerhaba <i>dünya</i>\n';
  const yeni = planUygula(vtt, { ok: true, olcek: 1, kaydirma: -4.5, noktalar: [] });
  assert.match(yeni, /00:00:05\.500 --> 00:00:07\.500 line:90%/);
  assert.match(yeni, /merhaba <i>dünya<\/i>/);
  // Negatife düşen zamanlar sıfırda duruyor.
  const kirpik = planUygula(vtt, { ok: true, olcek: 1, kaydirma: -30, noktalar: [] });
  assert.match(kirpik, /00:00:00\.000 --> 00:00:00\.100/);
});

test('planUygula plan yoksa metne dokunmaz', () => {
  const vtt = 'WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nbir\n';
  assert.equal(planUygula(vtt, { ok: false }), vtt);
  assert.equal(planUygula(vtt, null), vtt);
});

test('replikPuan aynı dizide 1, kaymış dizide düşük', () => {
  const dizi = [10, 20, 30, 40, 50, 60];
  assert.equal(replikPuan(dizi, dizi, 1, 0), 1);
  assert.ok(replikPuan(dizi, dizi, 1, 5) < 0.2);
});

test('zamanCevir parçalı planda noktalar arasını doğrusal bağlar', () => {
  const plan = { ok: true, olcek: 1, kaydirma: 0, noktalar: [[100, 2], [200, 6]] };
  assert.equal(zamanCevir(plan, 50), 52); // ilk noktadan önce: ilk ek
  assert.equal(zamanCevir(plan, 150), 154); // ortada: 2 ile 6 arası
  assert.equal(zamanCevir(plan, 300), 306); // son noktadan sonra: son ek
});
