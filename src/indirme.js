// Önden indirme: kişinin seçtiği bölüm/film diske indiriliyor, sonra torrent'e hiç
// gitmeden oynatılıyor.
//
// Neden motorun kendi önbelleğine bırakılmıyor: blok önbelleği sınıra gelince en eski
// bloğu siliyor (LRU), yani "indirdim" denen bölüm bir hafta sonra yok olabiliyor.
// Burada dosya kişinin seçtiği klasöre tam hâlde yazılıyor ve kendisi silene kadar
// duruyor.
//
// İndirme motorun kendi akışından (11470 taklidi) kapalı aralıklarla okunuyor: torrent
// doğru trackerlarla açılıyor, dosya adıyla eşleşiyor ve motorun "tamamını indir"
// kuyruğu şişmiyor (bkz. stremio-parca.js).
//
// Oynatma tarafı: `hazirDosya()` tam inmiş dosyayı söylüyor, motor taklidi onu diskten
// servis ediyor (src/motor/stremio-taklidi.js). Böylece oda, relay, masaüstü mpv ve
// telefon hiç değişmeden indirilen kopyayı oynatıyor.
//
// Kullanıcı başlatmadan hiçbir şey inmiyor ve her indirme panelde görünüyor: projenin
// "kullanıcının görmediği arka plan torrenti yok" kuralı bozulmuyor.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { STREMIO_BASE, localTorrentUrl } from '../public/js/shared/stream-url.js';

// Tek seferde istenen parça: büyük olunca motor ilerisini hazırlıyor, çok büyük olunca
// duraklatma/iptal geç tepki veriyor.
const PARCA = 64 * 1024 * 1024;
const KLASOR_ADI = 'BirlikteIzle-indirilen';
const UZANTILAR = new Set(['mkv', 'mp4', 'avi', 'ts', 'm4v', 'mov', 'webm']);

export const EN_COK_ES_ZAMANLI = 5;
// İndirme hız limiti (Mbps, bütün indirmelerin toplamı). 0 = sınırsız.
const hizLimitiGecerli = (n) => (Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 10) / 10 : null);
const esZamanliGecerli = (n) => (Number.isInteger(n) && n >= 1 && n <= EN_COK_ES_ZAMANLI ? n : null);
const DURUMLAR = { kuyrukta: 'kuyrukta', iniyor: 'iniyor', bitti: 'bitti', duraklatildi: 'duraklatildi', hata: 'hata' };

export function dosyaUzantisi(filename) {
  const u = String(filename || '').split('.').pop().toLowerCase();
  return UZANTILAR.has(u) ? u : 'mkv';
}

// Varsayılan HTTP okuyucu: motorun akışından kapalı aralık ister.
function varsayilanIstek(adres, bas, son) {
  return new Promise((coz, red) => {
    const istek = http.get(adres, { headers: { range: `bytes=${bas}-${son}`, 'x-indirme': '1' } }, (yanit) => {
      // 416: istenen yer dosyanın sonundan sonra (kayıttaki boyut tahmini gerçekten büyükse ya da dosya zaten tam inmişse).
      // "bytes */N" gerçek boyutu söylüyor: boş akışla döneriz, döngü boyutu düzeltip bitirir.
      if (yanit.statusCode === 416) {
        const gercek = Number(String(yanit.headers['content-range'] || '').split('/')[1]) || null;
        yanit.resume();
        if (gercek) return coz({ akis: Readable.from([]), toplam: gercek });
      }
      if (yanit.statusCode !== 206 && yanit.statusCode !== 200) {
        yanit.resume();
        red(new Error(`HTTP ${yanit.statusCode}`));
        return;
      }
      const aralik = String(yanit.headers['content-range'] || '');
      const toplam = Number(aralik.split('/')[1]) || null;
      coz({ akis: yanit, toplam });
    });
    istek.on('error', red);
    istek.setTimeout(120_000, () => istek.destroy(new Error('zaman aşımı')));
  });
}

export function createIndirme({
  dataDir,
  klasor = null,
  log = { info() {}, warn() {} },
  motorAdresi = STREMIO_BASE,
  istek = varsayilanIstek,
  onDegisim = () => {},
  // Hata sonrası otomatik yeniden deneme gecikmeleri (ms); boş dizi = yeniden deneme yok.
  yenidenDenemeGecikme = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000],
}) {
  const kayitYolu = path.join(dataDir, 'indirme.json');
  let ayarlar = { klasor: klasor || path.join(dataDir, 'indirilen'), kayitlar: [], esZamanli: 1, izlerkenDuraklat: false, hizLimitiMbps: 0 };
  const aktifler = new Map(); // id -> { id, iptal: boolean }: şu an inenler
  const denemeZamanlari = new Map(); // id -> zamanlayıcı: hata sonrası yeniden kuyruğa alma
  let engelFn = null; // (kayit) => true ise kayıt henüz başlatılmaz (ör. aynı dizinin önceki bölümünün kaynağı aranıyor)
  let izleniyor = false; // ayar açıkken indirilmemiş bir şey izleniyor: kuyruk bekliyor

  function oku() {
    try {
      const kayit = JSON.parse(fs.readFileSync(kayitYolu, 'utf8'));
      if (kayit && typeof kayit === 'object') {
        ayarlar = {
          klasor: typeof kayit.klasor === 'string' && kayit.klasor ? kayit.klasor : ayarlar.klasor,
          kayitlar: Array.isArray(kayit.kayitlar) ? kayit.kayitlar : [],
          esZamanli: esZamanliGecerli(kayit.esZamanli) ?? 1,
          izlerkenDuraklat: kayit.izlerkenDuraklat === true,
          hizLimitiMbps: hizLimitiGecerli(kayit.hizLimitiMbps) ?? 0,
        };
      }
    } catch { /* ilk çalıştırma: varsayılan */ }
    // Yarıda kalan indirmeler sunucu kapanınca "iniyor" kalmış olabilir: kuyruğa dönsün.
    for (const k of ayarlar.kayitlar) if (k.durum === DURUMLAR.iniyor) k.durum = DURUMLAR.kuyrukta;
  }

  // Hız sınırı: bütün indirmeler ortak bir zaman çizelgesini paylaşır. Her parça için "bu bayt en erken ne zaman geçebilir" hesaplanır,
  // erkense akış o kadar duraklatılır. Kısa süreli dalgalanmaya (250 ms) izin verir.
  let sonrakiAn = 0;
  function sinirGecikmesi(bayt) {
    const mbps = ayarlar.hizLimitiMbps;
    if (!mbps) { sonrakiAn = 0; return 0; }
    const simdi = Date.now();
    sonrakiAn = Math.max(sonrakiAn, simdi) + (bayt / (mbps * 125_000)) * 1000;
    return Math.max(0, sonrakiAn - simdi - 250);
  }

  function yaz() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(kayitYolu, JSON.stringify(ayarlar, null, 2));
    } catch (err) {
      log.warn('İndirme kaydı yazılamadı', { error: err.message });
    }
  }

  const kokKlasor = () => path.join(ayarlar.klasor, KLASOR_ADI);
  const klasoru = (k) => path.join(kokKlasor(), k.infoHash);
  const parcaYolu = (k) => path.join(klasoru(k), `${k.fileIdx ?? -1}.part`);
  const tamYolu = (k) => path.join(klasoru(k), `${k.fileIdx ?? -1}.${dosyaUzantisi(k.filename)}`);

  const bul = (id) => ayarlar.kayitlar.find((k) => k.id === id) || null;

  function bildir() {
    onDegisim(liste());
  }

  function liste() {
    return ayarlar.kayitlar.map((k) => ({
      id: k.id,
      ad: k.ad,
      type: k.type,
      contentId: k.contentId,
      poster: k.poster || null,
      toplu: k.toplu || null,
      deneme: k.deneme || 0,
      sonrakiDeneme: k.sonrakiDeneme || null,
      filename: k.filename || null,
      sources: Array.isArray(k.sources) ? k.sources : [],
      infoHash: k.infoHash,
      fileIdx: k.fileIdx,
      kalite: k.kalite,
      boyut: k.boyut,
      inen: k.inen || 0,
      durum: k.durum,
      izlemeBekliyor: izleniyor && k.durum === DURUMLAR.kuyrukta,
      hata: k.hata || null,
      tarih: k.tarih,
      yol: k.durum === DURUMLAR.bitti ? tamYolu(k) : null,
    }));
  }

  // Tam inmiş dosya (motor taklidi bunu diskten servis ediyor).
  function hazirDosya(infoHash, fileIdx, filename = null) {
    const ih = String(infoHash || '').toLowerCase();
    const idx = Number.isInteger(fileIdx) ? fileIdx : -1;
    const k = ayarlar.kayitlar.find((x) => x.infoHash === ih && (x.fileIdx ?? -1) === idx && x.durum === DURUMLAR.bitti)
      // Sıra numarası bilinmiyorsa (-1) ya da ad eşleşiyorsa: aynı torrent'in inen dosyası.
      || (filename ? ayarlar.kayitlar.find((x) => x.infoHash === ih && x.filename === filename && x.durum === DURUMLAR.bitti) : null);
    if (!k) return null;
    const yol = tamYolu(k);
    let boy = 0;
    try {
      boy = fs.statSync(yol).size;
    } catch {
      return null; // kişi dosyayı silmiş: kayıt yanıltmasın
    }
    return { yol, boy, filename: k.filename, id: k.id };
  }

  async function parcaIndir(k, a) {
    fs.mkdirSync(klasoru(k), { recursive: true });
    const yol = parcaYolu(k);
    let inen = 0;
    try {
      inen = fs.statSync(yol).size;
    } catch { /* yeni dosya */ }

    const adres = localTorrentUrl(
      { infoHash: k.infoHash, fileIdx: k.fileIdx, sources: k.sources || [], filename: k.filename },
      motorAdresi,
    );

    while (!a.iptal) {
      const son = k.boyut ? Math.min(k.boyut - 1, inen + PARCA - 1) : inen + PARCA - 1;
      if (k.boyut && inen >= k.boyut) break;
      const { akis, toplam } = await istek(adres, inen, son);
      // Kayıttaki boyut kaynağın başlığından tahmin edilmiş olabiliyor ("2.7 GB" yazıyor, dosya 3.2 GB çıkıyor):
      // sunucunun bildirdiği gerçek toplam (Content-Range) her zaman geçerli. Tahmin gerçekten küçükse indirme
      // %100'de takılıp ilerlemenin üstüne çıkıyor, büyükse dosya eksik kalıp "yarıda kaldı" diyordu.
      if (toplam && k.boyut !== toplam) {
        k.boyut = toplam;
        yaz();
      }
      const hedef = fs.createWriteStream(yol, { flags: 'a' });
      await new Promise((coz, red) => {
        let sonYazim = Date.now();
        const bitir = (err) => {
          if (err) {
            hedef.destroy();
            red(err);
          } else coz();
        };
        akis.on('data', (parca) => {
          inen += parca.length;
          k.inen = inen;
          // Kayıt dosyasını her parçada değil, saniyede bir güncelliyoruz.
          if (Date.now() - sonYazim > 1000) {
            sonYazim = Date.now();
            yaz();
            bildir();
          }
          if (a.iptal) { akis.destroy(); return; }
          // pipe yerine elle yazıyoruz: pipe, hedef boşalınca (drain) kaynağı kendiliğinden yeniden başlatıp hız sınırının
          // duraklatmasını bozuyordu. Duraklatma hem dosya tamponu (drain) hem hız sınırı bitince kalkar.
          const yazildi = hedef.write(parca);
          const bekle = sinirGecikmesi(parca.length);
          if (!yazildi || bekle > 0) {
            akis.pause();
            let bekleyen = 0;
            const devam = () => { if (--bekleyen <= 0 && !a.iptal) akis.resume(); };
            if (!yazildi) { bekleyen++; hedef.once('drain', devam); }
            if (bekle > 0) { bekleyen++; setTimeout(devam, bekle); }
          }
        });
        akis.on('end', () => hedef.end());
        // Kaynağı iptalde yok ettiğimizde pipe hedefi kendiliğinden kapatmıyor
        // ('end' gelmiyor): elle kapatmazsak bu söz hiç çözülmüyor ve indirme
        // döngüsü sonsuza kilitleniyordu.
        akis.on('close', () => { if (!hedef.writableEnded) hedef.end(); });
        akis.on('error', bitir);
        hedef.on('error', bitir);
        hedef.on('close', () => bitir(null));
      });
      if (k.boyut && inen >= k.boyut) break;
      if (!k.boyut) break; // boyut bilinmiyorsa tek parça sonrası durdur (bilgi gelmedi)
    }

    if (a.iptal) return false;
    if (k.boyut && inen < k.boyut) throw new Error('indirme yarıda kaldı');
    fs.renameSync(yol, tamYolu(k));
    return true;
  }

  // Boş yuva kadar kuyruktaki indirmeyi başlatır (eşzamanlı sayısı ayardan). Yuva boşalınca
  // (biten, duraklatılan, iptal edilen) yeniden çağrılır; senkron çalıştığı için yarış yok.
  // Sıradaki başlatılacak kayıt: aynı dizinin bölümleri HER ZAMAN sezon/bölüm sırasıyla (S1E1, S1E2, ...),
  // farklı içerikler önce eklenen önce. Bölümlerin kaynakları farklı sürelerde bulunsa da sıra bozulmaz:
  // engelFn önceki bölümün kaynağı hâlâ aranıyorsa sonrakini bekletir.
  function siradakiKayit() {
    const adaylar = ayarlar.kayitlar.filter((x) => x.durum === DURUMLAR.kuyrukta && !aktifler.has(x.id) && !(engelFn && engelFn(x)));
    if (!adaylar.length) return null;
    const ayir = (k) => {
      const [imdb, s, e] = String(k.contentId || '').split(':');
      return { grup: `${k.type}|${imdb || k.infoHash}`, s: Number(s) || 0, e: Number(e) || 0 };
    };
    const grupZamani = new Map(); // içeriğin en erken kayıt zamanı: toplu istek sırası
    for (const k of ayarlar.kayitlar) {
      const g = ayir(k).grup;
      const t = Date.parse(k.tarih) || 0;
      if (!grupZamani.has(g) || t < grupZamani.get(g)) grupZamani.set(g, t);
    }
    return [...adaylar].sort((a, b) => {
      const x = ayir(a);
      const y = ayir(b);
      return (grupZamani.get(x.grup) - grupZamani.get(y.grup)) || (x.s - y.s) || (x.e - y.e) || ((Date.parse(a.tarih) || 0) - (Date.parse(b.tarih) || 0));
    })[0];
  }

  function kuyruguIsle() {
    if (izleniyor) return;
    while (aktifler.size < ayarlar.esZamanli) {
      const k = siradakiKayit();
      if (!k) break;
      const a = { id: k.id, iptal: false };
      aktifler.set(k.id, a);
      k.durum = DURUMLAR.iniyor;
      k.hata = null;
      yaz();
      bildir();
      log.info('İndirme başladı', { id: k.id, ad: k.ad, infoHash: k.infoHash });
      calistir(k, a);
    }
  }

  // Hata sonrası kendiliğinden yeniden deneme: gecikme artarak (15 sn ... 10 dk), en çok gecikme listesi kadar kez.
  // Durum hata olarak kalır (sebep görünsün), zamanı gelince kuyruğa döner ve kaldığı yerden sürer.
  function yenidenDenemeKur(k) {
    const sira = k.deneme || 0;
    if (sira >= yenidenDenemeGecikme.length) { k.sonrakiDeneme = null; return; }
    const gecikme = yenidenDenemeGecikme[sira];
    k.sonrakiDeneme = new Date(Date.now() + gecikme).toISOString();
    clearTimeout(denemeZamanlari.get(k.id));
    const z = setTimeout(() => {
      denemeZamanlari.delete(k.id);
      const guncel = bul(k.id);
      if (!guncel || guncel.durum !== DURUMLAR.hata) return; // kullanıcı bu arada sildi/duraklattı/sürdürdü
      guncel.deneme = (guncel.deneme || 0) + 1;
      guncel.sonrakiDeneme = null;
      guncel.durum = DURUMLAR.kuyrukta;
      log.info('İndirme yeniden deneniyor', { id: guncel.id, ad: guncel.ad, deneme: guncel.deneme });
      yaz();
      bildir();
      kuyruguIsle();
    }, gecikme);
    z.unref?.();
    denemeZamanlari.set(k.id, z);
  }
  const denemeyiBirak = (id) => { clearTimeout(denemeZamanlari.get(id)); denemeZamanlari.delete(id); };

  async function calistir(k, a) {
    try {
      const bittiMi = await parcaIndir(k, a);
      if (bittiMi) {
        k.durum = DURUMLAR.bitti;
        k.deneme = 0;
        k.sonrakiDeneme = null;
        k.inen = k.boyut || k.inen;
        log.info('İndirme bitti', { id: k.id, ad: k.ad, mb: Math.round((k.inen || 0) / 1e6) });
      } else if (k.durum === DURUMLAR.iniyor) {
        k.durum = DURUMLAR.duraklatildi;
      }
    } catch (err) {
      // Duraklatma/iptal de akışı koparıyor: durumu onlar koyduysa dokunmuyoruz.
      if (k.durum === DURUMLAR.iniyor) {
        k.durum = DURUMLAR.hata;
        k.hata = err.message;
        log.warn('İndirme başarısız', { id: k.id, ad: k.ad, error: err.message });
        yenidenDenemeKur(k);
      }
    }
    aktifler.delete(k.id);
    yaz();
    bildir();
    kuyruguIsle();
  }

  oku();
  // Sunucu kapalıyken/diskte yer yokken hata alanlar açılışta bir kez daha denensin (deneme hakkı kaldıysa).
  for (const k of ayarlar.kayitlar) if (k.durum === DURUMLAR.hata && (k.deneme || 0) < yenidenDenemeGecikme.length) yenidenDenemeKur(k);
  // Sunucu kapanınca yarıda kalan indirmeler kuyrukta duruyor: açılışta kendiliğinden
  // sürüyor (kişi bu indirmeleri kendisi başlatmıştı, panelde de görünüyorlar).
  if (ayarlar.kayitlar.some((k) => k.durum === DURUMLAR.kuyrukta)) {
    log.info('Yarıda kalan indirme sürdürülüyor', {
      sayi: ayarlar.kayitlar.filter((k) => k.durum === DURUMLAR.kuyrukta).length,
    });
    kuyruguIsle();
  }

  return {
    liste,
    hazirDosya,
    // Şu an inen dosyaların torrent kimlikleri: sahipsiz torrent temizliği bunları kapatmasın.
    inenHashler: () => [...aktifler.keys()].map((id) => bul(id)?.infoHash).filter(Boolean),
    ayar: () => ({ klasor: ayarlar.klasor, kokKlasor: kokKlasor(), esZamanli: ayarlar.esZamanli, izlerkenDuraklat: ayarlar.izlerkenDuraklat, hizLimitiMbps: ayarlar.hizLimitiMbps, izleniyor, enCokEsZamanli: EN_COK_ES_ZAMANLI }),

    // Yeni indirme. Aynı dosya zaten varsa onu döndürüyor.
    ekle({ infoHash, fileIdx = null, filename = null, ad = '', type = null, contentId = null, kalite = null, boyut = null, sources = [], poster = null, toplu = null }) {
      const ih = String(infoHash || '').toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(ih)) return { error: 'badInfoHash' };
      const varolan = ayarlar.kayitlar.find((k) => k.infoHash === ih && (k.fileIdx ?? -1) === (fileIdx ?? -1));
      if (varolan) {
        if (varolan.durum === DURUMLAR.duraklatildi || varolan.durum === DURUMLAR.hata) {
          varolan.durum = DURUMLAR.kuyrukta;
          yaz();
          bildir();
          kuyruguIsle();
        }
        return { kayit: liste().find((x) => x.id === varolan.id) };
      }
      const kayit = {
        id: `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        infoHash: ih,
        fileIdx: Number.isInteger(fileIdx) ? fileIdx : null,
        filename,
        ad: String(ad || filename || ih).slice(0, 200),
        type,
        contentId,
        poster: typeof poster === 'string' && /^https?:\/\//.test(poster) ? poster : null,
        // Toplu istek türü (arayüzdeki etiket için): 'sezon' | 'dizi' | null (tek tek eklenen).
        toplu: toplu === 'sezon' || toplu === 'dizi' ? toplu : null,
        kalite,
        boyut: Number(boyut) || null,
        inen: 0,
        sources,
        durum: DURUMLAR.kuyrukta,
        tarih: new Date().toISOString(),
      };
      ayarlar.kayitlar.push(kayit);
      yaz();
      bildir();
      kuyruguIsle();
      return { kayit: liste().find((x) => x.id === kayit.id) };
    },

    // Aynı dizinin önceki bölümünün kaynağı hâlâ aranırken sonraki bölüm başlamasın (indirme-otomatik.js koyar).
    engelKoy(fn) { engelFn = typeof fn === 'function' ? fn : null; },
    sirayiIsle() { kuyruguIsle(); },
    duraklat(id) {
      const k = bul(id);
      if (!k) return { error: 'yok' };
      if (k.durum === DURUMLAR.iniyor) {
        k.durum = DURUMLAR.duraklatildi;
        if (aktifler.has(id)) aktifler.get(id).iptal = true;
      } else if (k.durum === DURUMLAR.kuyrukta || k.durum === DURUMLAR.hata) k.durum = DURUMLAR.duraklatildi;
      denemeyiBirak(id);
      k.sonrakiDeneme = null;
      yaz();
      bildir();
      return { ok: true };
    },

    surdur(id) {
      const k = bul(id);
      if (!k) return { error: 'yok' };
      if (k.durum === DURUMLAR.bitti) return { ok: true };
      denemeyiBirak(id);
      k.deneme = 0; // elle sürdürünce deneme hakkı yenilenir
      k.sonrakiDeneme = null;
      k.durum = DURUMLAR.kuyrukta;
      k.hata = null;
      yaz();
      bildir();
      kuyruguIsle();
      return { ok: true };
    },

    // Kayıttan ve diskten siler (yarım dosya da gider).
    sil(id) {
      const k = bul(id);
      if (!k) return { error: 'yok' };
      if (aktifler.has(id)) aktifler.get(id).iptal = true;
      denemeyiBirak(id);
      for (const yol of [parcaYolu(k), tamYolu(k)]) {
        try {
          fs.rmSync(yol, { force: true });
        } catch { /* dosya yoksa sorun değil */ }
      }
      try {
        fs.rmdirSync(klasoru(k));
      } catch { /* başka dosya varsa kalsın */ }
      ayarlar.kayitlar = ayarlar.kayitlar.filter((x) => x.id !== id);
      yaz();
      bildir();
      return { ok: true };
    },

    // Klasör değişimi: yeni yer yazılabilir olmalı. İnen dosyalar taşınmıyor,
    // kayıtlarda kalıyor; yeni indirmeler yeni yere iniyor.
    klasorAyarla(yeni) {
      const yol = String(yeni || '').trim();
      if (!yol) return { error: 'bosYol' };
      try {
        fs.mkdirSync(path.join(yol, KLASOR_ADI), { recursive: true });
        const deneme = path.join(yol, KLASOR_ADI, `.yazma-denemesi-${process.pid}`);
        fs.writeFileSync(deneme, 'x');
        fs.rmSync(deneme, { force: true });
      } catch (err) {
        return { error: 'yazilamiyor', detay: err.message };
      }
      ayarlar.klasor = yol;
      yaz();
      bildir();
      return { ok: true, klasor: yol };
    },

    // Sunucu kapanırken: açık indirme kesilsin, kayıt dursun.
    durdur() {
      for (const a of aktifler.values()) a.iptal = true;
    },

    // "İzlerken indirmeleri duraklat" ayarı (varsayılan kapalı). Kapatılırsa bekleyenler sürer.
    izlerkenDuraklatAyarla(acik) {
      ayarlar.izlerkenDuraklat = acik === true;
      yaz();
      this.izleniyorBildir(izleniyor);
      return { ok: true, izlerkenDuraklat: ayarlar.izlerkenDuraklat };
    },

    // Sunucu bildiriyor: şu an indirilmemiş bir şey izleniyor mu? Ayar açıksa inenler durur (yarım dosya
    // kalıyor, sürünce kaldığı yerden devam eder), kuyruk bekler; izleme bitince kendiliğinden sürer.
    izleniyorBildir(izliyor) {
      const yeni = ayarlar.izlerkenDuraklat && izliyor === true;
      if (yeni === izleniyor) return;
      izleniyor = yeni;
      if (izleniyor) {
        for (const [id, a] of aktifler) {
          const k = bul(id);
          if (k?.durum === DURUMLAR.iniyor) k.durum = DURUMLAR.kuyrukta;
          a.iptal = true;
        }
        log.info('Başka bir şey izleniyor: indirmeler duraklatıldı');
      } else {
        log.info('İzleme bitti: indirmeler sürüyor');
      }
      yaz();
      bildir();
      kuyruguIsle();
    },

    // Toplam indirme hızı sınırı (Mbps; 0 = sınırsız). Çalışan indirmelere hemen uygulanır.
    hizLimitiAyarla(mbps) {
      const g = hizLimitiGecerli(Number(mbps));
      if (g === null) return { error: 'gecersizHiz' };
      ayarlar.hizLimitiMbps = g;
      sonrakiAn = 0;
      yaz();
      bildir();
      return { ok: true, hizLimitiMbps: g };
    },

    // Aynı anda kaç dosya insin (1-5). Düşürülünce çalışanlar bitene kadar sürer, yenisi başlamaz.
    esZamanliAyarla(n) {
      const g = esZamanliGecerli(Number(n));
      if (!g) return { error: 'gecersizSayi' };
      ayarlar.esZamanli = g;
      yaz();
      bildir();
      kuyruguIsle();
      return { ok: true, esZamanli: g };
    },
  };
}
