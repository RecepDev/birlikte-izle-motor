// İki altyazı dosyasını birbirine hizalar (DOM'suz: sunucu ve istemciler ortak kullanır).
//
// Mantık: iki dosya aynı filmi anlatıyor, diller farklı ama konuşmaların zamanlaması
// aynı. "Replik ne zaman başlıyor" dizisini iki dosyadan çıkarıp üst üste kaydırıyoruz;
// en çok replik başlangıcının aynı ana düştüğü kaydırma aradığımız gecikmedir.
//
// Üç aşama:
//   1. Kaba tarama (1 sn kutular, konuşma var/yok): aday kaydırmalar, ±180 sn ve
//      sık görülen kare hızı oranları taranır. Hızlı ama ayırt etmesi zayıf.
//   2. İnce tarama: adaylar replik başlangıcı eşleşmesiyle puanlanır. Bu puan
//      alakasız iki dosyayı (yanlış film, yanlış bölüm) ayıran ölçü.
//   3. Parçalı düzeltme: film dilimlere bölünüp her dilime kendi gecikmesi bulunur,
//      kırılmanın tam yeri aranır. Araya reklam arası girmiş ya da sahne eklenmiş
//      kopyalarda kayma film ortasında değişiyor; tek bir sayı bunu çözemiyor.

// Sık görülen kare hızı oranları: 23,976 / 24 / 25 arası dönüşümler.
const OLCEKLER = [1, 23.976 / 25, 25 / 23.976, 24 / 25, 25 / 24, 23.976 / 24, 24 / 23.976];

const VARSAYILAN = {
  kabaKutu: 1, // sn
  enBuyukKaydirma: 180, // sn
  inceAdim: 0.05, // sn
  inceAralik: 2, // aday kaydırmanın ± kaç sn'si taranacak
  adaySayisi: 12, // kaba taramadan ince ölçüme geçen aday sayısı
  dilimSn: 240, // parçalı düzeltmede dilim uzunluğu
  dilimArama: 25, // dilim başına ± arama aralığı (sn)
  tolerans: 0.35, // iki repliğin "aynı an" sayıldığı en büyük fark (sn)
  enAzGuven: 0.35, // replik eşleşme oranı: bunun altında hizalama uygulanmaz
  kesinGuven: 0.6, // bunun üstü "güvenli", arası "şüpheli" sayılıyor
  enAzDilimGuven: 0.3,
  enAzDilimCue: 6,
  enBuyukDilimZiplama: 20, // komşu dilimler arası izin verilen fark (sn)
};

const zamanDesen = /(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})/;

const saniye = (s, d, sn, ms) => Number(s) * 3600 + Number(d) * 60 + Number(sn) + Number(String(ms).padEnd(3, '0')) / 1000;

// VTT/SRT metninden [{ b: başlangıç, s: son }] çıkarır (saniye).
export function cueAraliklari(metin) {
  const out = [];
  for (const satir of String(metin).split('\n')) {
    const m = satir.match(zamanDesen);
    if (!m) continue;
    const b = saniye(m[1], m[2], m[3], m[4]);
    const s = saniye(m[5], m[6], m[7], m[8]);
    if (s > b && s - b < 60) out.push({ b, s });
  }
  return out.sort((x, y) => x.b - y.b);
}

// Cue'ları metinleriyle birlikte verir: [{ b, s, metin }]. Masaüstünde altyazıyı mpv
// çizdiği için sayfanın <track> ipuçları çalışmıyor; ekranda hangi repliğin durduğunu
// bilmek gereken yerler (zor kelime kutusu) buradan okuyor.
export function cueListesi(metin) {
  const out = [];
  const satirlar = String(metin).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < satirlar.length; i += 1) {
    const m = satirlar[i].match(zamanDesen);
    if (!m) continue;
    const govde = [];
    for (let j = i + 1; j < satirlar.length && satirlar[j].trim() !== ''; j += 1) govde.push(satirlar[j]);
    out.push({
      b: saniye(m[1], m[2], m[3], m[4]),
      s: saniye(m[5], m[6], m[7], m[8]),
      // VTT etiketleri (<i>, <b>, {\an8}) metinden çıkıyor: kelime ayrıştırmaya karışmasın.
      metin: govde.join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim(),
    });
  }
  return out.sort((a, b) => a.b - b.b);
}

// "Konuşma var mı" ikili sinyali: her kutu 0 ya da 1.
function sinyal(araliklar, kutu, uzunluk) {
  const n = Math.ceil(uzunluk / kutu) + 1;
  const dizi = new Uint8Array(n);
  for (const { b, s } of araliklar) {
    const bas = Math.max(0, Math.floor(b / kutu));
    const son = Math.min(n - 1, Math.ceil(s / kutu));
    for (let i = bas; i <= son; i += 1) dizi[i] = 1;
  }
  return dizi;
}

// Kaba puan: kutuların örtüşmesi (Dice). Yalnız aday bulmak için.
function kabaPuan(ref, hedef, kutu, olcek, kaydirma) {
  let kesisim = 0;
  let refEtkin = 0;
  let hedefEtkin = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const r = ref[i];
    const j = Math.round(((i * kutu - kaydirma) / olcek) / kutu);
    const h = j >= 0 && j < hedef.length ? hedef[j] : 0;
    refEtkin += r;
    hedefEtkin += h;
    if (r && h) kesisim += 1;
  }
  if (!refEtkin || !hedefEtkin) return 0;
  return (2 * kesisim) / (refEtkin + hedefEtkin);
}

// Sıralı dizide t'ye en yakın değerin uzaklığı.
function enYakinFark(sirali, t) {
  let alt = 0;
  let ust = sirali.length - 1;
  let en = Infinity;
  while (alt <= ust) {
    const orta = (alt + ust) >> 1;
    const fark = sirali[orta] - t;
    const mutlak = fark < 0 ? -fark : fark;
    if (mutlak < en) en = mutlak;
    if (fark < 0) alt = orta + 1;
    else ust = orta - 1;
  }
  return en;
}

// Replik başlangıcı eşleşme oranı: 0 (hiç) ile 1 (hepsi) arası.
// hedef zamanı -> ref zamanı dönüşümü: ref = olcek * hedef + kaydirma
function eslesmeOrani(refTum, hedefListe, olcek, kaydirma, tolerans, refSayi) {
  let eslesen = 0;
  for (const t of hedefListe) {
    if (enYakinFark(refTum, olcek * t + kaydirma) <= tolerans) eslesen += 1;
  }
  const taban = Math.min(refSayi, hedefListe.length);
  return taban < 3 ? 0 : eslesen / taban;
}

// Dışarıdan ölçmek için (test): bütün dosya üzerinden eşleşme oranı.
export function replikPuan(refBaslangiclar, hedefBaslangiclar, olcek, kaydirma, tolerans = VARSAYILAN.tolerans) {
  return eslesmeOrani(refBaslangiclar, hedefBaslangiclar, olcek, kaydirma, tolerans, refBaslangiclar.length);
}

// Sıralı dizide t'ye en yakın değerin işaretli farkı (ref - t).
function enYakinIsaretli(sirali, t) {
  let alt = 0;
  let ust = sirali.length - 1;
  let en = Infinity;
  let deger = 0;
  while (alt <= ust) {
    const orta = (alt + ust) >> 1;
    const fark = sirali[orta] - t;
    const mutlak = fark < 0 ? -fark : fark;
    if (mutlak < en) { en = mutlak; deger = fark; }
    if (fark < 0) alt = orta + 1;
    else ust = orta - 1;
  }
  return { mutlak: en, fark: deger };
}

const ortanca = (dizi) => {
  if (!dizi.length) return 0;
  const s = [...dizi].sort((a, b) => a - b);
  const o = s.length >> 1;
  return s.length % 2 ? s[o] : (s[o - 1] + s[o]) / 2;
};

// Tolerans 0,35 sn olduğu için "en iyi" kaydırmaların hepsi tam puan alıyor ve
// arama bu düzlüğün kenarında durabiliyor. Eşleşen repliklerin ortanca farkını
// ekleyerek kaydırmayı düzlüğün ortasına, yani gerçek değere çekiyoruz.
function kaydirmayiIncelt(refTum, hedefListe, olcek, kaydirma, tolerans) {
  const farklar = [];
  for (const t of hedefListe) {
    const { mutlak, fark } = enYakinIsaretli(refTum, olcek * t + kaydirma);
    if (mutlak <= tolerans) farklar.push(fark);
  }
  if (farklar.length < 3) return kaydirma;
  return Math.round((kaydirma + ortanca(farklar)) * 1000) / 1000;
}

// 1. ve 2. aşama: filmin bütünü için tek bir ölçek + kaydırma.
function genelHizalama(ref, hedef, ayar) {
  const kabaRef = sinyal(ref.araliklar, ayar.kabaKutu, ref.uzunluk);
  const kabaHedef = sinyal(hedef.araliklar, ayar.kabaKutu, hedef.uzunluk);
  const adaylar = [];
  for (const olcek of OLCEKLER) {
    for (let k = -ayar.enBuyukKaydirma; k <= ayar.enBuyukKaydirma; k += ayar.kabaKutu) {
      adaylar.push({ olcek, kaydirma: k, puan: kabaPuan(kabaRef, kabaHedef, ayar.kabaKutu, olcek, k) });
    }
  }
  adaylar.sort((a, b) => b.puan - a.puan);

  // Aynı tepenin yanındaki komşuları aday saymamak için birbirine yakın olanları atla.
  const secili = [];
  for (const a of adaylar) {
    if (secili.some((s) => s.olcek === a.olcek && Math.abs(s.kaydirma - a.kaydirma) < ayar.inceAralik * 2)) continue;
    secili.push(a);
    if (secili.length >= ayar.adaySayisi) break;
  }
  // Kaydırmasız hal her zaman denenir: iki dosya zaten uyumluysa onu kaçırmayalım.
  if (!secili.some((s) => s.olcek === 1 && Math.abs(s.kaydirma) < ayar.inceAralik)) {
    secili.push({ olcek: 1, kaydirma: 0 });
  }

  let enIyi = { olcek: 1, kaydirma: 0, guven: 0 };
  for (const aday of secili) {
    for (let k = aday.kaydirma - ayar.inceAralik; k <= aday.kaydirma + ayar.inceAralik; k += ayar.inceAdim) {
      const kaydirma = Math.round(k * 1000) / 1000;
      const guven = eslesmeOrani(ref.baslangiclar, hedef.baslangiclar, aday.olcek, kaydirma, ayar.tolerans, ref.baslangiclar.length);
      if (guven > enIyi.guven) enIyi = { olcek: aday.olcek, kaydirma, guven };
    }
  }
  const incelmis = kaydirmayiIncelt(ref.baslangiclar, hedef.baslangiclar, enIyi.olcek, enIyi.kaydirma, ayar.tolerans);
  return { ...enIyi, kaydirma: incelmis };
}

// 3. aşama: dilim dilim artakalan kaymayı bul. Dönen noktalar genel dönüşümden
// SONRAKİ zaman eksenine göredir: ek(t) kadar daha kaydırmak gerekiyor.
function parcaliDuzeltme(genel, ref, hedef, ayar) {
  const { olcek, kaydirma } = genel;
  const sonZaman = ref.uzunluk;
  const noktalar = [];
  for (let bas = 0; bas < sonZaman; bas += ayar.dilimSn) {
    const son = Math.min(sonZaman, bas + ayar.dilimSn);
    const refSayi = ref.baslangiclar.filter((t) => t >= bas && t <= son).length;
    if (refSayi < ayar.enAzDilimCue) continue;
    // Bu dilime düşen hedef replikleri (genel dönüşümden sonra).
    const hedefListe = hedef.baslangiclar.filter((t) => {
      const c = olcek * t + kaydirma;
      return c >= bas - ayar.dilimArama && c <= son + ayar.dilimArama;
    });
    if (hedefListe.length < ayar.enAzDilimCue) continue;

    let enIyi = { ek: 0, guven: 0 };
    for (let e = -ayar.dilimArama; e <= ayar.dilimArama; e += ayar.inceAdim) {
      const ek = Math.round(e * 1000) / 1000;
      // Dilim sınırları ref ekseninde: kaydırılan hedef replikleri bu pencereye düşenler.
      const icerdekiler = hedefListe.filter((t) => {
        const c = olcek * t + kaydirma + ek;
        return c >= bas && c <= son;
      });
      if (icerdekiler.length < ayar.enAzDilimCue) continue;
      const guven = eslesmeOrani(ref.baslangiclar, icerdekiler, olcek, kaydirma + ek, ayar.tolerans, refSayi);
      if (guven > enIyi.guven) enIyi = { ek, guven };
    }
    if (enIyi.guven < ayar.enAzDilimGuven) continue;
    const dilimIci = hedefListe.filter((t) => {
      const c = olcek * t + kaydirma + enIyi.ek;
      return c >= bas && c <= son;
    });
    const ince = kaydirmayiIncelt(ref.baslangiclar, dilimIci, olcek, kaydirma + enIyi.ek, ayar.tolerans) - kaydirma;
    noktalar.push({ t: (bas + son) / 2, ek: Number(ince.toFixed(3)), guven: Number(enIyi.guven.toFixed(3)) });
  }

  // Tek bir dilimin saçma bir değere atlaması altyazıyı bozar: komşusundan
  // çok uzak duran noktaları atıyoruz.
  const temiz = noktalar.filter((n, i) => {
    const komsu = noktalar[i - 1] || noktalar[i + 1];
    return !komsu || Math.abs(n.ek - komsu.ek) <= ayar.enBuyukDilimZiplama;
  });
  return kirilmalariKeskinlestir(temiz, genel, ref, hedef, ayar);
}

// Kayma film ortasında birden değişmişse (reklam arası, eklenmiş sahne) dilim
// ortalarını düz çizgiyle birleştirmek kırılmanın iki yanında birkaç saniyelik
// hata bırakıyor. Burada kırılmanın tam yerini arayıp geçişi dikleştiriyoruz.
function kirilmalariKeskinlestir(noktalar, genel, ref, hedef, ayar) {
  const { olcek, kaydirma } = genel;
  const out = [];
  for (let i = 0; i < noktalar.length; i += 1) {
    const n = noktalar[i];
    const sonraki = noktalar[i + 1];
    out.push(n);
    if (!sonraki || Math.abs(sonraki.ek - n.ek) < 1) continue;

    let enIyi = null;
    for (let tb = n.t; tb <= sonraki.t; tb += 1) {
      const solHedef = hedef.baslangiclar.filter((t) => {
        const c = olcek * t + kaydirma + n.ek;
        return c >= n.t && c < tb;
      });
      const sagHedef = hedef.baslangiclar.filter((t) => {
        const c = olcek * t + kaydirma + sonraki.ek;
        return c >= tb && c <= sonraki.t;
      });
      const solRef = ref.baslangiclar.filter((t) => t >= n.t && t < tb).length;
      const sagRef = ref.baslangiclar.filter((t) => t >= tb && t <= sonraki.t).length;
      const sol = eslesmeOrani(ref.baslangiclar, solHedef, olcek, kaydirma + n.ek, ayar.tolerans, solRef);
      const sag = eslesmeOrani(ref.baslangiclar, sagHedef, olcek, kaydirma + sonraki.ek, ayar.tolerans, sagRef);
      const puan = sol * solHedef.length + sag * sagHedef.length;
      if (!enIyi || puan > enIyi.puan) enIyi = { tb, puan };
    }
    if (enIyi) {
      // Kırılmanın iki yanına birbirine çok yakın iki nokta: aradaki doğrusal
      // geçiş 0,1 sn'ye iniyor, yani pratikte basamak oluyor.
      out.push({ t: enIyi.tb - 0.05, ek: n.ek, guven: n.guven });
      out.push({ t: enIyi.tb + 0.05, ek: sonraki.ek, guven: sonraki.guven });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// Hizalama planı üretir. ref = doğru zamanlı (host'un seçtiği) altyazı metni,
// hedef = hizalanacak ikinci altyazı metni.
export function hizalamaPlani(refMetin, hedefMetin, secenek = {}) {
  const ayar = { ...VARSAYILAN, ...secenek };
  const refAraliklar = cueAraliklari(refMetin);
  const hedefAraliklar = cueAraliklari(hedefMetin);
  if (refAraliklar.length < 10 || hedefAraliklar.length < 10) {
    return { ok: false, sebep: 'azCue', guven: 0 };
  }
  const ref = {
    araliklar: refAraliklar,
    baslangiclar: refAraliklar.map((a) => a.b),
    uzunluk: refAraliklar[refAraliklar.length - 1].s,
  };
  const hedef = {
    araliklar: hedefAraliklar,
    baslangiclar: hedefAraliklar.map((a) => a.b),
    uzunluk: hedefAraliklar[hedefAraliklar.length - 1].s,
  };

  const genel = genelHizalama(ref, hedef, ayar);
  if (genel.guven < ayar.enAzGuven) {
    return { ok: false, sebep: 'oturmadi', guven: Number(genel.guven.toFixed(3)) };
  }

  const noktalar = parcaliDuzeltme(genel, ref, hedef, ayar);
  const degisken = noktalar.length > 1
    && Math.max(...noktalar.map((n) => n.ek)) - Math.min(...noktalar.map((n) => n.ek)) > 0.5;

  const plan = {
    ok: true,
    mod: degisken ? 'parcali' : (genel.olcek === 1 ? 'sabit' : 'oranli'),
    olcek: genel.olcek,
    kaydirma: Number(genel.kaydirma.toFixed(3)),
    noktalar: degisken ? noktalar.map((n) => [Number(n.t.toFixed(2)), Number(n.ek.toFixed(3))]) : [],
  };

  // Güven, parçalı düzeltmeden SONRAKİ uyuma göre: kullanıcıya gösterdiğimiz
  // sayı son halin ne kadar oturduğunu anlatsın.
  let eslesen = 0;
  for (const t of hedef.baslangiclar) {
    if (enYakinFark(ref.baslangiclar, zamanCevir(plan, t)) <= ayar.tolerans) eslesen += 1;
  }
  const guven = eslesen / Math.min(ref.baslangiclar.length, hedef.baslangiclar.length);
  if (guven < ayar.enAzGuven) {
    return { ok: false, sebep: 'oturmadi', guven: Number(guven.toFixed(3)) };
  }
  return { ...plan, guven: Number(guven.toFixed(3)), kesin: guven >= ayar.kesinGuven };
}

// Plana göre ikinci altyazının bir zamanını ref zamanına çevirir.
export function zamanCevir(plan, t) {
  if (!plan?.ok) return t;
  const temel = plan.olcek * t + plan.kaydirma;
  const n = plan.noktalar;
  if (!n?.length) return temel;
  if (temel <= n[0][0]) return temel + n[0][1];
  if (temel >= n[n.length - 1][0]) return temel + n[n.length - 1][1];
  for (let i = 1; i < n.length; i += 1) {
    if (temel <= n[i][0]) {
      const [t0, e0] = n[i - 1];
      const [t1, e1] = n[i];
      const oran = t1 === t0 ? 0 : (temel - t0) / (t1 - t0);
      return temel + e0 + (e1 - e0) * oran;
    }
  }
  return temel;
}

const ikiHane = (n) => String(n).padStart(2, '0');

export function zamanYaz(t) {
  const guvenli = Math.max(0, t);
  const saat = Math.floor(guvenli / 3600);
  const dakika = Math.floor((guvenli % 3600) / 60);
  const sn = Math.floor(guvenli % 60);
  const ms = Math.round((guvenli - Math.floor(guvenli)) * 1000);
  return `${ikiHane(saat)}:${ikiHane(dakika)}:${ikiHane(sn)}.${String(ms).padStart(3, '0')}`;
}

// VTT metnindeki bütün cue zamanlarını plana göre yeniden yazar.
export function planUygula(vtt, plan) {
  if (!plan?.ok) return vtt;
  return String(vtt).split('\n').map((satir) => {
    const m = satir.match(zamanDesen);
    if (!m) return satir;
    // Kırpma sırası önemli: filmin başına düşen cue'da hem başlangıç hem bitiş
    // sıfıra inerse cue sıfır uzunlukta kalıp hiç görünmüyor.
    const b = Math.max(0, zamanCevir(plan, saniye(m[1], m[2], m[3], m[4])));
    const s = Math.max(zamanCevir(plan, saniye(m[5], m[6], m[7], m[8])), b + 0.1);
    const kalan = satir.slice(m[0].length);
    return `${zamanYaz(b)} --> ${zamanYaz(s)}${kalan}`;
  }).join('\n');
}
