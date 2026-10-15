// Zor kelime sözlüğünü üretir: İngilizce Wiktionary'nin çeviri bölümlerinden
// İngilizce → Türkçe karşılıkları çeker, sıklık sırasıyla birleştirip
// public/veri/en-tr.json.gz dosyasını yazar.
//
// Veri: Wiktionary (CC BY-SA 3.0 + GFDL) · sıklık: SUBTLEX-US (ISC paketi).
// Çalıştırma: node scripts/sozluk-uret.mjs [--limit N] [--bastan]
// Yarıda kalırsa aynı komut kaldığı yerden sürer (data/sozluk-ilerleme.json).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const KOK = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FREKANS = path.join(KOK, 'node_modules', 'subtlex-word-frequencies', 'index.json');
const ILERLEME = path.join(KOK, 'data', 'sozluk-ilerleme.json');
const CIKTI_DIZIN = path.join(KOK, 'public', 'veri');
const API = 'https://en.wiktionary.org/w/api.php';
// HTTP başlıkları yalnız ASCII taşıyabiliyor: burada Türkçe harf kullanma.
const UA = 'BirlikteIzle/0.1 (watch-together app; dictionary build)';

// Sıklık listesinde bu kadar az geçen kelimeler alınmıyor (yazım hatası, uydurma ad).
const EN_AZ_GECIS = 5;
// Sıralama bilgisi yalnız bu sıraya kadar saklanıyor: kolay/zor kararı için yeterli.
const SIRA_SINIRI = 8000;
const TOPLU = 50; // API bir istekte en çok 50 başlık veriyor

const POS = {
  Noun: 'isim', Verb: 'fiil', Adjective: 'sıfat', Adverb: 'zarf', Interjection: 'ünlem',
  Phrase: 'söz', Proverb: 'atasözü', Preposition: 'ilgeç', Conjunction: 'bağlaç',
  Pronoun: 'adıl', Numeral: 'sayı', Determiner: 'belirteç',
};

const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Wiktionary wikitext ayrıştırma ------------------------------------

// Sayfanın İngilizce bölümündeki Türkçe çevirileri [{ pos, tr: [...] }] olarak döndürür.
export function cevirileriAyikla(wikitext) {
  const sonuc = [];
  let ingilizce = false;
  let pos = '';
  for (const satir of String(wikitext).split('\n')) {
    const dil = satir.match(/^==\s*([^=]+?)\s*==$/);
    if (dil) {
      ingilizce = dil[1].trim() === 'English';
      pos = '';
      continue;
    }
    if (!ingilizce) continue;
    const baslik = satir.match(/^===+\s*([^=]+?)\s*===+$/);
    if (baslik) {
      const ad = baslik[1].trim();
      if (POS[ad]) pos = POS[ad];
      continue;
    }
    if (!satir.includes('|tr|')) continue;
    // Şablonun dört biçimi var: {{t|tr|…}}, {{t+|tr|…}} ve çok düzenlenen maddelerde
    // çift t'li karşılıkları ({{tt|tr|…}}, {{tt+|tr|…}}). Çift t'yi atlamak "house"
    // için "ev, hane" yerine yalnız "yuva"yı almamıza yol açıyordu.
    // {{t-check|tr|…}} (doğrulanmamış çeviri) kasten alınmıyor.
    const ceviriler = [...satir.matchAll(/\{\{tt?[+\-]?\*?\|tr\|([^}|]+)/g)]
      // Baştaki yıldız yeniden kurulmuş biçimi işaretliyor (*imek): kullanıcıya gösterilmez.
      .map((m) => m[1].trim().replace(/^\*+/, '').trim())
      // Yapım eki girdileri (-giller) kelime değil: kutuya girmesinler.
      .filter((t) => t && !t.includes('=') && !t.startsWith('-') && t.length <= 40);
    if (ceviriler.length) sonuc.push({ pos, tr: ceviriler });
  }
  return sonuc;
}

// Aynı sözcük türünü tek satırda toplar, en çok 3 tür × 3 karşılık bırakır.
export function anlamlariTopla(ayiklanan) {
  const turlere = new Map();
  for (const { pos, tr } of ayiklanan) {
    const anahtar = pos || '';
    if (!turlere.has(anahtar)) turlere.set(anahtar, []);
    const liste = turlere.get(anahtar);
    for (const t of tr) if (!liste.includes(t)) liste.push(t);
  }
  return [...turlere.entries()].slice(0, 3).map(([pos, tr]) => [pos, ...tr.slice(0, 3)]);
}

// Büyük maddelerde (run, house, go...) çeviriler ayrı bir alt sayfada tutuluyor:
// ana sayfada yalnız "{{see translation subpage}}" yazıyor. O maddeler ikinci turda
// <kelime>/translations sayfasından çekiliyor; alt sayfanın yapısı ana sayfayla aynı.
const ALT_SAYFA = /\{\{see translation subpage/i;

// İki ayrı kaynaktan (ana sayfa + alt sayfa) gelen anlamları tek listede toplar.
export function anlamlariBirlestir(a, b) {
  const out = [];
  for (const [pos, ...tr] of [...(a || []), ...(b || [])]) {
    const varolan = out.find((x) => x[0] === pos);
    if (!varolan) out.push([pos, ...tr]);
    else for (const t of tr) if (!varolan.includes(t) && varolan.length < 4) varolan.push(t);
  }
  return out.slice(0, 3);
}

// ---- API ---------------------------------------------------------------

async function sayfalariGetir(basliklar) {
  const govde = new URLSearchParams({
    action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
    format: 'json', formatversion: '2', maxlag: '5', titles: basliklar.join('|'),
  });
  for (let deneme = 0; deneme < 5; deneme += 1) {
    let yanit;
    try {
      yanit = await fetch(API, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
        body: govde,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      console.warn(`  ağ hatası (${err.message}), ${deneme + 1}. deneme`);
      await bekle(2000 * (deneme + 1));
      continue;
    }
    if (yanit.status === 429 || yanit.status >= 500) {
      const bekleme = Number(yanit.headers.get('retry-after')) * 1000 || 3000 * (deneme + 1);
      console.warn(`  sunucu ${yanit.status}, ${Math.round(bekleme / 1000)} sn bekleniyor`);
      await bekle(bekleme);
      continue;
    }
    const veri = await yanit.json();
    if (veri?.error?.code === 'maxlag') {
      await bekle(5000);
      continue;
    }
    return veri?.query?.pages || [];
  }
  throw new Error('API 5 denemede yanıt vermedi');
}

// ---- ana akış ----------------------------------------------------------

function frekansListesi() {
  if (!fs.existsSync(FREKANS)) {
    console.error('Sıklık listesi yok. Önce: npm install');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(FREKANS, 'utf8'));
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  const bastan = process.argv.includes('--bastan');

  const frekans = frekansListesi();
  const sira = new Map();
  frekans.forEach((e, i) => { if (!sira.has(e.word.toLowerCase())) sira.set(e.word.toLowerCase(), i); });

  const kelimeler = [];
  const gorulen = new Set();
  for (const e of frekans) {
    if (e.count < EN_AZ_GECIS) break;
    const k = e.word.toLowerCase();
    if (!/^[a-z][a-z'-]{1,30}$/.test(k) || gorulen.has(k)) continue;
    gorulen.add(k);
    kelimeler.push(k);
    if (kelimeler.length >= limit) break;
  }

  let sozluk = {};
  let indeks = 0;
  let altSayfalar = [];
  let altIndeks = 0;
  if (!bastan && fs.existsSync(ILERLEME)) {
    const kayit = JSON.parse(fs.readFileSync(ILERLEME, 'utf8'));
    sozluk = kayit.sozluk || {};
    indeks = kayit.indeks || 0;
    altSayfalar = kayit.altSayfalar || [];
    altIndeks = kayit.altIndeks || 0;
    console.log(`kaldığı yerden sürüyor: ${indeks}/${kelimeler.length}`);
  }
  console.log(`${kelimeler.length} kelime, ${Math.ceil((kelimeler.length - indeks) / TOPLU)} istek`);

  const baslangic = Date.now();
  while (indeks < kelimeler.length) {
    const obek = kelimeler.slice(indeks, indeks + TOPLU);
    const sayfalar = await sayfalariGetir(obek);
    for (const sayfa of sayfalar) {
      const metin = sayfa?.revisions?.[0]?.slots?.main?.content;
      if (!metin) continue;
      const anlamlar = anlamlariTopla(cevirileriAyikla(metin));
      if (anlamlar.length) sozluk[String(sayfa.title).toLowerCase()] = anlamlar;
      if (ALT_SAYFA.test(metin)) altSayfalar.push(String(sayfa.title));
    }
    indeks += obek.length;
    fs.mkdirSync(path.dirname(ILERLEME), { recursive: true });
    fs.writeFileSync(ILERLEME, JSON.stringify({ indeks, sozluk, altSayfalar, altIndeks }));
    // Wikimedia hızlı istek dizisine 429 ile karşılık veriyor ve geri çekilme
    // bekleyişi toplamda daha uzun sürüyor: baştan yavaş gitmek daha hızlı.
    await bekle(1200);
    if (indeks % 1000 < TOPLU) {
      const gecen = Math.round((Date.now() - baslangic) / 1000);
      console.log(`${indeks}/${kelimeler.length} · ${Object.keys(sozluk).length} karşılık · ${gecen} sn`);
    }
  }

  // ---- ikinci tur: çevirileri alt sayfada olan maddeler ----
  if (altSayfalar.length) {
    console.log(`alt sayfa: ${altSayfalar.length} madde, ${Math.ceil((altSayfalar.length - altIndeks) / TOPLU)} istek`);
  }
  while (altIndeks < altSayfalar.length) {
    const obek = altSayfalar.slice(altIndeks, altIndeks + TOPLU);
    const sayfalar = await sayfalariGetir(obek.map((t) => `${t}/translations`));
    for (const sayfa of sayfalar) {
      const metin = sayfa?.revisions?.[0]?.slots?.main?.content;
      if (!metin) continue;
      const ad = String(sayfa.title).replace(/\/translations$/, '').toLowerCase();
      const anlamlar = anlamlariBirlestir(sozluk[ad], anlamlariTopla(cevirileriAyikla(metin)));
      if (anlamlar.length) sozluk[ad] = anlamlar;
    }
    altIndeks += obek.length;
    fs.writeFileSync(ILERLEME, JSON.stringify({ indeks, sozluk, altSayfalar, altIndeks }));
    await bekle(1200);
    if (altIndeks % 500 < TOPLU) console.log(`alt sayfa ${altIndeks}/${altSayfalar.length}`);
  }

  // ---- dosyayı yaz ----
  const kelime = {};
  for (const [k, anlamlar] of Object.entries(sozluk)) kelime[k] = { a: anlamlar };
  for (const [k, s] of sira) {
    if (s < SIRA_SINIRI) kelime[k] = { ...(kelime[k] || {}), r: s };
  }
  const cikti = {
    surum: 1,
    tarih: new Date().toISOString().slice(0, 10),
    siraSiniri: SIRA_SINIRI,
    kaynak: {
      sozluk: 'İngilizce Wiktionary çeviri bölümleri · CC BY-SA 3.0 / GFDL',
      sira: 'SUBTLEX-US · Brysbaert & New (2009)',
    },
    kelime,
  };
  fs.mkdirSync(CIKTI_DIZIN, { recursive: true });
  const json = JSON.stringify(cikti);
  const gz = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(path.join(CIKTI_DIZIN, 'en-tr.json.gz'), gz);
  console.log(`bitti: ${Object.keys(sozluk).length} kelimenin karşılığı var, `
    + `${Object.keys(kelime).length} kayıt · ${(json.length / 1e6).toFixed(1)} MB → `
    + `${(gz.length / 1e6).toFixed(2)} MB sıkıştırılmış`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sozluk-uret.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
