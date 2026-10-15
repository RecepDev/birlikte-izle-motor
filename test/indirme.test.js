import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createIndirme, dosyaUzantisi } from '../src/indirme.js';

const IH = 'a'.repeat(40);
const sessiz = { info() {}, warn() {} };

function geciciDizin() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bi-indirme-'));
}

// Sahte motor: istenen aralığı veren bir akış döndürür.
function sahteMotor(icerik, { hata = null, yavas = false } = {}) {
  const cagrilar = [];
  return {
    cagrilar,
    async istek(adres, bas, son) {
      cagrilar.push({ adres, bas, son });
      if (hata) throw new Error(hata);
      const dilim = icerik.subarray(bas, Math.min(icerik.length, son + 1));
      const akis = yavas
        ? new Readable({
          read() {
            // Parça parça ver: duraklatma araya girebilsin.
            if (this.konum === undefined) this.konum = 0;
            if (this.konum >= dilim.length) return this.push(null);
            const p = dilim.subarray(this.konum, this.konum + 8);
            this.konum += 8;
            setTimeout(() => this.push(p), 5);
          },
        })
        : Readable.from([dilim]);
      return { akis, toplam: icerik.length };
    },
  };
}

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

async function durumBekle(ind, id, durum, sinir = 3000) {
  const bas = Date.now();
  for (;;) {
    const k = ind.liste().find((x) => x.id === id);
    if (k?.durum === durum) return k;
    if (Date.now() - bas > sinir) throw new Error(`durum "${durum}" olmadı: ${k?.durum} (${k?.hata || ''})`);
    await bekle(10);
  }
}

test('dosyaUzantisi bilinen uzantıyı korur, bilinmeyende mkv', () => {
  assert.equal(dosyaUzantisi('Film.2020.1080p.mkv'), 'mkv');
  assert.equal(dosyaUzantisi('bolum.mp4'), 'mp4');
  assert.equal(dosyaUzantisi('dosya.txt'), 'mkv');
  assert.equal(dosyaUzantisi(null), 'mkv');
});

test('dosya tam iniyor, diske yazılıyor ve hazirDosya onu buluyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('a'.repeat(5000));
  const motor = sahteMotor(icerik);
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });

  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 2, filename: 'Bolum.S01E01.mkv', ad: 'Dizi 1x01', boyut: icerik.length });
  // ekle() kuyruğu hemen işlemeye başlıyor: kayıt ya kuyrukta ya iniyor.
  assert.ok(['kuyrukta', 'iniyor'].includes(kayit.durum), kayit.durum);
  const bitti = await durumBekle(ind, kayit.id, 'bitti');
  assert.equal(bitti.inen, icerik.length);

  const hazir = ind.hazirDosya(IH, 2);
  assert.ok(hazir, 'hazır dosya bulunmalı');
  assert.equal(hazir.boy, icerik.length);
  assert.equal(fs.readFileSync(hazir.yol).length, icerik.length);
  assert.match(hazir.yol, /BirlikteIzle-indirilen/);
  assert.match(hazir.yol, /2\.mkv$/);
  // Yarım dosya kalmamalı.
  assert.equal(fs.existsSync(`${hazir.yol.replace(/\.mkv$/, '')}.part`), false);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('büyük dosya parça parça isteniyor (kapalı aralıklar)', async () => {
  const dizin = geciciDizin();
  // PARCA 64 MB; 150 MB üç istek eder.
  const boy = 150 * 1024 * 1024;
  const motor = {
    cagrilar: [],
    async istek(adres, bas, son) {
      motor.cagrilar.push([bas, son]);
      return { akis: Readable.from([Buffer.alloc(son - bas + 1)]), toplam: boy };
    },
  };
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, boyut: boy, ad: 'Büyük' });
  await durumBekle(ind, kayit.id, 'bitti', 20_000);
  assert.equal(motor.cagrilar.length, 3);
  assert.deepEqual(motor.cagrilar[0], [0, 64 * 1024 * 1024 - 1]);
  assert.equal(motor.cagrilar[2][1], boy - 1, 'son parça dosyanın sonuna kadar');
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('indirme duraklatılıp kaldığı yerden sürüyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('b'.repeat(400));
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(icerik, { yavas: true }).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 1, boyut: icerik.length, ad: 'Film' });
  await durumBekle(ind, kayit.id, 'iniyor');
  await bekle(60);
  ind.duraklat(kayit.id);
  const durdu = await durumBekle(ind, kayit.id, 'duraklatildi');
  assert.ok(durdu.inen > 0 && durdu.inen < icerik.length, `yarıda durmalı: ${durdu.inen}`);

  ind.surdur(kayit.id);
  const bitti = await durumBekle(ind, kayit.id, 'bitti', 5000);
  assert.equal(bitti.inen, icerik.length);
  // İçerik bozulmamış olmalı (kaldığı yerden eklendi, baştan yazılmadı).
  assert.equal(fs.readFileSync(ind.hazirDosya(IH, 1).yol).toString(), icerik.toString());
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('motor hata verirse durum "hata" ve sebebi yazılıyor', async () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.alloc(10), { hata: 'HTTP 504' }).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, boyut: 10, ad: 'Olmayan' });
  const k = await durumBekle(ind, kayit.id, 'hata');
  assert.match(k.hata, /504/);
  assert.equal(ind.hazirDosya(IH, 0), null);
  // Sürdürmek yeniden deniyor.
  ind.surdur(kayit.id);
  await durumBekle(ind, kayit.id, 'hata');
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('sil: kayıt ve dosya gidiyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('c'.repeat(100));
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(icerik).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, boyut: icerik.length, ad: 'Silinecek' });
  await durumBekle(ind, kayit.id, 'bitti');
  const yol = ind.hazirDosya(IH, 0).yol;
  ind.sil(kayit.id);
  assert.equal(ind.liste().length, 0);
  assert.equal(fs.existsSync(yol), false);
  assert.equal(ind.hazirDosya(IH, 0), null);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('aynı dosya iki kez eklenmiyor; duraklatılmışsa kuyruğa dönüyor', async () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.from('d'.repeat(200)), { yavas: true }).istek });
  const bir = ind.ekle({ infoHash: IH, fileIdx: 3, boyut: 200, ad: 'Bir' });
  const iki = ind.ekle({ infoHash: IH, fileIdx: 3, boyut: 200, ad: 'Bir (tekrar)' });
  assert.equal(iki.kayit.id, bir.kayit.id);
  assert.equal(ind.liste().length, 1);
  await durumBekle(ind, bir.kayit.id, 'bitti', 5000);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('geçersiz infoHash reddediliyor', () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.alloc(0)).istek });
  assert.deepEqual(ind.ekle({ infoHash: 'kisa' }), { error: 'badInfoHash' });
  assert.deepEqual(ind.ekle({}), { error: 'badInfoHash' });
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('kayıtlar diskte kalıyor; yarıda kalan indirme kuyruğa dönüyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('e'.repeat(300));
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(icerik, { yavas: true }).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, boyut: icerik.length, ad: 'Yarım' });
  await durumBekle(ind, kayit.id, 'iniyor');
  await bekle(40);
  ind.durdur(); // sunucu kapanıyor

  // Yeni sunucu: kayıt okunuyor, "iniyor" kalanlar kuyruğa dönüyor.
  const yeni = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(icerik).istek });
  const k = yeni.liste().find((x) => x.id === kayit.id);
  assert.ok(k, 'kayıt diskten okunmalı');
  assert.ok(['kuyrukta', 'iniyor', 'bitti'].includes(k.durum), k.durum);
  assert.equal(k.ad, 'Yarım');
  // Yeni yönetici indirmeyi sürdürüyor: temizlemeden önce bitmesini bekle.
  await durumBekle(yeni, kayit.id, 'bitti', 5000);
  yeni.durdur();
  await bekle(30);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('klasorAyarla yazılabilirliği denetliyor', () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.alloc(0)).istek });
  const yeni = path.join(dizin, 'baska-yer');
  const sonuc = ind.klasorAyarla(yeni);
  assert.equal(sonuc.ok, true);
  assert.equal(ind.ayar().klasor, yeni);
  assert.match(ind.ayar().kokKlasor, /BirlikteIzle-indirilen$/);
  assert.deepEqual(ind.klasorAyarla(''), { error: 'bosYol' });
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('hazirDosya: dosya elle silinmişse kayıt yanıltmıyor', async () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.from('f'.repeat(50))).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, boyut: 50, ad: 'Film' });
  await durumBekle(ind, kayit.id, 'bitti');
  const yol = ind.hazirDosya(IH, 0).yol;
  fs.rmSync(yol);
  assert.equal(ind.hazirDosya(IH, 0), null);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('hazirDosya dosya adıyla da eşleşiyor (sıra numarası kaymışsa)', async () => {
  const dizin = geciciDizin();
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: sahteMotor(Buffer.from('g'.repeat(20))).istek });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 5, filename: 'Bolum.mkv', boyut: 20, ad: 'Bölüm' });
  await durumBekle(ind, kayit.id, 'bitti');
  assert.ok(ind.hazirDosya(IH, 9, 'Bolum.mkv'), 'ad eşleşmesi');
  assert.equal(ind.hazirDosya(IH, 9, 'Baska.mkv'), null);
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('eşzamanlı sayısı: 1 iken sırayla, 2 iken ikisi birden iniyor; ayar diskte kalıyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('a'.repeat(4000));
  const motor = sahteMotor(icerik, { yavas: true });
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  assert.equal(ind.ayar().esZamanli, 1, 'varsayılan 1');

  const a = ind.ekle({ infoHash: IH, fileIdx: 0, ad: 'A', boyut: icerik.length }).kayit;
  const b = ind.ekle({ infoHash: IH, fileIdx: 1, ad: 'B', boyut: icerik.length }).kayit;
  await bekle(60);
  let durumlar = ind.liste().map((x) => x.durum);
  assert.deepEqual(durumlar, ['iniyor', 'kuyrukta']);
  assert.deepEqual(ind.inenHashler(), [IH]);

  assert.deepEqual(ind.esZamanliAyarla(2), { ok: true, esZamanli: 2 });
  await bekle(60);
  durumlar = ind.liste().map((x) => x.durum);
  assert.deepEqual(durumlar, ['iniyor', 'iniyor']);
  assert.ok(ind.esZamanliAyarla(0).error && ind.esZamanliAyarla(6).error && ind.esZamanliAyarla(1.5).error);

  ind.durdur();
  await bekle(50);
  // Yeni örnek ayarı diskten okuyor.
  const yeni = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  assert.equal(yeni.ayar().esZamanli, 2);
  yeni.durdur();
  void a; void b;
});

test('izlerken duraklat: ayar kapalıyken hiçbir şey durmaz; açıkken izleme bitince kaldığı yerden sürer', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('a'.repeat(3000));
  const motor = sahteMotor(icerik, { yavas: true });
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  assert.equal(ind.ayar().izlerkenDuraklat, false, 'varsayılan kapalı');

  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 0, ad: 'A', boyut: icerik.length });
  await bekle(40);
  ind.izleniyorBildir(true); // ayar kapalı: etkisiz
  assert.equal(ind.liste()[0].durum, 'iniyor');
  assert.equal(ind.ayar().izleniyor, false);

  ind.izlerkenDuraklatAyarla(true);
  ind.izleniyorBildir(true);
  await bekle(40);
  let k = ind.liste()[0];
  assert.equal(k.durum, 'kuyrukta');
  assert.equal(k.izlemeBekliyor, true);
  assert.deepEqual(ind.inenHashler(), []);
  const ara = k.inen;
  const yeni = ind.ekle({ infoHash: IH, fileIdx: 1, ad: 'B', boyut: icerik.length }).kayit;
  await bekle(40);
  assert.equal(ind.liste().find((x) => x.id === yeni.id).durum, 'kuyrukta', 'izlerken yeni indirme başlamaz');

  ind.izleniyorBildir(false);
  const bitti = await durumBekle(ind, kayit.id, 'bitti', 8000);
  assert.equal(bitti.inen, icerik.length);
  assert.ok(ara <= icerik.length);
  ind.durdur();
});

test('hız limiti: ayar doğrulanır, diske yazılır, indirmeyi yavaşlatır', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('b'.repeat(250_000));
  // Gerçek akış gibi parçalı (50 KB'lık 5 parça): hız sınırı parçalar arasında bekletir.
  const motor = {
    async istek(adres, bas, son) {
      const dilim = icerik.subarray(bas, Math.min(icerik.length, son + 1));
      const parcalar = [];
      for (let i = 0; i < dilim.length; i += 50_000) parcalar.push(dilim.subarray(i, i + 50_000));
      return { akis: Readable.from(parcalar), toplam: icerik.length };
    },
  };
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  assert.equal(ind.ayar().hizLimitiMbps, 0, 'varsayılan sınırsız');
  assert.ok(ind.hizLimitiAyarla(-1).error && ind.hizLimitiAyarla('x').error && ind.hizLimitiAyarla(200000).error);

  // 1 Mbps = 125 000 bayt/sn: 250 000 baytlık dosya ~1,5-2 sn sürmeli (250 ms tolerans, son parça bekletilmez). Sınırsız olsa ms'ler içinde biterdi.
  assert.deepEqual(ind.hizLimitiAyarla(1), { ok: true, hizLimitiMbps: 1 });
  const bas = Date.now();
  ind.ekle({ infoHash: IH, fileIdx: 0, ad: 'Hız', boyut: icerik.length });
  while (ind.liste()[0].durum !== 'bitti' && Date.now() - bas < 8000) await bekle(50);
  const sure = Date.now() - bas;
  assert.equal(ind.liste()[0].durum, 'bitti');
  assert.ok(sure >= 1000, `limit uygulanmadı: ${sure} ms`);

  ind.durdur();
  await bekle(50);
  const yeni = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
  assert.equal(yeni.ayar().hizLimitiMbps, 1, 'ayar diskten okunur');
  yeni.durdur();
});

test('başlıktan tahmin edilen boyut yanlışsa gerçek boyut (Content-Range) kullanılıyor', async () => {
  for (const tahmin of [3000, 8000]) {
    const dizin = geciciDizin();
    const icerik = Buffer.from('b'.repeat(5000));
    const motor = sahteMotor(icerik);
    const ind = createIndirme({ dataDir: dizin, log: sessiz, istek: motor.istek });
    const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 1, filename: 'Bolum.mkv', ad: 'Dizi', boyut: tahmin });
    const bitti = await durumBekle(ind, kayit.id, 'bitti');
    assert.equal(bitti.boyut, 5000, `tahmin ${tahmin}`);
    assert.equal(bitti.inen, 5000);
    assert.equal(fs.readFileSync(ind.hazirDosya(IH, 1).yol).length, 5000);
    fs.rmSync(dizin, { recursive: true, force: true });
  }
});

test('hata olursa kendiliğinden yeniden deneniyor ve bitiyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('c'.repeat(3000));
  let kalanHata = 2;
  const motor = sahteMotor(icerik);
  const istek = async (adres, bas, son) => {
    if (kalanHata-- > 0) throw new Error('geçici hata');
    return motor.istek(adres, bas, son);
  };
  const ind = createIndirme({ dataDir: dizin, log: sessiz, istek, yenidenDenemeGecikme: [20, 20, 20] });
  const { kayit } = ind.ekle({ infoHash: IH, fileIdx: 4, filename: 'B.mkv', ad: 'Dizi', boyut: icerik.length });
  const bitti = await durumBekle(ind, kayit.id, 'bitti', 4000);
  assert.equal(bitti.inen, 3000);
  assert.equal(bitti.deneme, 0, 'başarıdan sonra sayaç sıfırlanır');
  fs.rmSync(dizin, { recursive: true, force: true });
});

test('dizi bölümleri sezon/bölüm sırasıyla başlıyor', async () => {
  const dizin = geciciDizin();
  const icerik = Buffer.from('d'.repeat(400));
  const motor = sahteMotor(icerik, { yavas: true }); // ilk indirme kuyruğu bir süre meşgul tutsun
  const baslayan = [];
  const log = { info: (m, o) => { if (m === 'İndirme başladı') baslayan.push(o.ad); }, warn() {} };
  const ind = createIndirme({ dataDir: dizin, log, istek: motor.istek });
  const H = (n) => String(n).repeat(40).slice(0, 40);
  const ekle = (ep, ad, ct) => ind.ekle({ infoHash: H(ep), fileIdx: 0, filename: `e${ep}.mkv`, ad, type: 'series', contentId: ct, boyut: 400 }).kayit.id;
  const ilk = ekle(9, 'Bekleyen', 'tt9:1:1'); // başka dizi, hemen başlar ve kuyruğu tutar
  // Ters sırada: S1E3, S1E1, S1E2 (kaynaklar farklı sürede bulunmuş gibi).
  const ids = [ekle(3, 'E3', 'tt1:1:3'), ekle(1, 'E1', 'tt1:1:1'), ekle(2, 'E2', 'tt1:1:2')];
  for (const id of [ilk, ...ids]) await durumBekle(ind, id, 'bitti', 15000);
  assert.deepEqual(baslayan, ['Bekleyen', 'E1', 'E2', 'E3']);
  fs.rmSync(dizin, { recursive: true, force: true });
});
