// İndirilenler: indirme kuyruğu ve inmiş dosyalar (ana ekranla aynı görünümde).
import { indirilenAc } from './indirilenden-ac.js';
import { api, el, $ } from './api.js';
import { afisYok } from './afis.js';
import { onayla, sor } from '/js/diyalog.js';

const DURUM = {
  kuyrukta: '⏳ Sırada',
  iniyor: '↓ İniyor',
  bitti: '✅ İndirildi',
  duraklatildi: '⏸️ Duraklatıldı',
  hata: '⚠️ Hata',
};
const ARAMA = { sirada: '🔎 Kaynak sırada', araniyor: '🔎 Kaynak aranıyor', bulunamadi: '⚠️ Kaynak bulunamadı', hata: '⚠️ Hata' };
const boyut = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round((n || 0) / 1e6)} MB`);

let veri = { kayitlar: [], arama: [] };

// Eski indirme kayıtlarında afiş yok: içerik kimliğiyle Cinemeta'dan (sunucu /api/detay) tamamlanır, bir kez istenir.
const afisOnbellek = new Map(); // imdb kimliği -> afiş adresi | null (arıyor/yok)
function eksikAfisiTamamla(kayitlar) {
  let yeni = false;
  for (const k of kayitlar) {
    const imdb = String(k.contentId || '').split(':')[0];
    if (k.poster || !/^tt\d+$/.test(imdb) || afisOnbellek.has(imdb)) continue;
    afisOnbellek.set(imdb, null);
    yeni = true;
    api(`/api/detay?${new URLSearchParams({ type: k.type || 'movie', id: imdb })}`)
      .then((d) => { if (d?.poster) { afisOnbellek.set(imdb, d.poster); ciz(); } })
      .catch(() => {});
  }
  return yeni;
}
const afisBul = (k) => k.poster || afisOnbellek.get(String(k.contentId || '').split(':')[0]) || null;

// Görünüm: ızgara (yan yana kartlar) ya da liste (alt alta). Seçim tarayıcıda hatırlanır.
let gorunum = 'izgara';
try { if (localStorage.getItem('dlGorunum') === 'liste') gorunum = 'liste'; } catch { /* yok */ }
function gorunumUygula() {
  $('#dl-icerik').classList.toggle('dl-liste', gorunum === 'liste');
  $('#dl-izgara-dugme').classList.toggle('secili', gorunum === 'izgara');
  $('#dl-liste-dugme').classList.toggle('secili', gorunum === 'liste');
}
for (const [id, ad] of [['#dl-izgara-dugme', 'izgara'], ['#dl-liste-dugme', 'liste']]) {
  $(id).addEventListener('click', () => {
    gorunum = ad;
    try { localStorage.setItem('dlGorunum', ad); } catch { /* yok */ }
    gorunumUygula();
    ciz();
  });
}
gorunumUygula();

async function islem(yol, govde) {
  await api(`/api/indirme/${yol}`, { method: 'POST', body: govde }).catch((err) => alert(err.message));
  yenile();
}

// Hızı iki yoklama arasındaki farktan hesapla (sunucu hız vermiyor).
const onceki = new Map(); // id -> { inen, t }
function hizMbps(k) {
  const simdi = Date.now();
  const o = onceki.get(k.id);
  onceki.set(k.id, { inen: k.inen, t: simdi });
  if (!o || k.durum !== 'iniyor' || simdi - o.t < 500) return null;
  return Math.max(0, ((k.inen - o.inen) * 8) / ((simdi - o.t) / 1000) / 1e6);
}

// Canlı: şu an veri gerçekten akıyor mu. İki çizim arasında inen bayt arttıysa canlı (hız Mbps).
// "iniyor" durumundaki ama baytı artmayan kayıt takılı/bekliyor sayılır. Kayıt ve grup başına ayrı örnek tutulur.
const canliOrnek = new Map(); // anahtar -> { inen, t, hiz }
function canliHiz(anahtar, inen) {
  const simdi = Date.now();
  const o = canliOrnek.get(anahtar);
  if (!o) { canliOrnek.set(anahtar, { inen, t: simdi, hiz: 0 }); return 0; }
  if (simdi - o.t < 500) return o.hiz;
  const hiz = inen > o.inen ? ((inen - o.inen) * 8) / ((simdi - o.t) / 1000) / 1e6 : 0;
  canliOrnek.set(anahtar, { inen, t: simdi, hiz });
  return hiz;
}

function kart({ poster, ad, alt, yuzde = null, dugmeler = [], vurgu = '' }) {
  return el('div', { class: `dl-kart ${vurgu}` },
    el('div', { class: 'dl-afis' }, poster
      ? el('img', { src: poster, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(afisYok()) })
      : afisYok()),
    el('div', { class: 'dl-govde' },
      el('div', { class: 'dl-ad', title: ad }, ad),
      el('div', { class: 'dl-alt' }, alt),
      yuzde === null ? null : el('div', { class: 'cubuk' }, el('div', { style: `width:${yuzde}%` })),
      el('div', { class: 'dl-dugmeler' }, ...dugmeler)));
}

function kayitAlt(k) {
  const yuzde = k.boyut ? Math.min(100, Math.round((k.inen / k.boyut) * 100)) : 0;
  const hiz = hizMbps(k);
  const durum = k.izlemeBekliyor ? '⏸️ İzleme bitince sürecek' : DURUM[k.durum] || k.durum;
  return [durum, k.kalite, k.boyut ? `${boyut(k.inen)} / ${boyut(k.boyut)}` : boyut(k.inen),
    k.durum === 'iniyor' || k.durum === 'duraklatildi' ? `%${yuzde}` : null,
    hiz !== null ? `${hiz.toFixed(1)} Mbps` : null, k.hata].filter(Boolean).join(' · ');
}

const yuzdeGoster = (k) => (k.durum === 'iniyor' || k.durum === 'duraklatildi' || k.durum === 'kuyrukta'
  ? (k.boyut ? Math.min(100, Math.round((k.inen / k.boyut) * 100)) : 0) : null);

function kayitDugmeleri(k) {
  const dugmeler = [];
  if (k.durum === 'bitti' && k.contentId && k.type) {
    // "Oda aç" ekranı olmadan: indirilen dosyadan doğrudan oda açılır.
    const izle = el('button', { type: 'button', class: 'primary' }, '▶ İzle');
    izle.addEventListener('click', () => indirilenAc(k, k.ad, izle));
    dugmeler.push(izle);
  }
  if (k.durum === 'iniyor' || k.durum === 'kuyrukta') dugmeler.push(el('button', { type: 'button', onclick: () => islem('duraklat', { id: k.id }) }, 'Duraklat'));
  if (k.durum === 'duraklatildi' || k.durum === 'hata') dugmeler.push(el('button', { type: 'button', onclick: () => islem('surdur', { id: k.id }) }, 'Sürdür'));
  dugmeler.push(el('button', {
    type: 'button',
    class: 'danger',
    onclick: async () => {
      const soru = k.durum === 'bitti' ? `"${k.ad}" diskten silinsin mi? Bir daha izlemek için yeniden inmesi gerekir.` : `"${k.ad}" indirmesi iptal edilip yarım dosya silinsin mi?`;
      if (await onayla(soru)) islem('sil', { id: k.id });
    },
  }, k.durum === 'bitti' ? 'Sil' : 'İptal'));
  return dugmeler;
}

function kayitKarti(k) {
  return kart({
    poster: afisBul(k), ad: k.ad, alt: kayitAlt(k), dugmeler: kayitDugmeleri(k),
    yuzde: yuzdeGoster(k),
    vurgu: k.durum === 'iniyor' ? 'iniyor' : '',
  });
}

// Aynı dizinin bölümleri tek kartta: kapak ve dizi adı üstte, bölümler altında.
const BOLUM_RE = /^(.*?)\s+S(\d+)E(\d+)\b\s*(?:·\s*(.*?))?(?:\s*·\s*\d{3,4}p)?\s*$/i;
function bolumBilgi(k) {
  const m = BOLUM_RE.exec(k.ad || '');
  const sezon = m ? Number(m[2]) : 0;
  const bolum = m ? Number(m[3]) : 0;
  const no = `S${String(sezon).padStart(2, '0')}E${String(bolum).padStart(2, '0')}`;
  return { dizi: m ? m[1] : k.ad, sezon, bolum, etiket: m ? `${no}${m[4] ? ` · ${m[4]}` : ''}` : k.ad };
}

function grupla(kayitlar) {
  const gruplar = new Map();
  const tekler = [];
  for (const k of kayitlar) {
    const bilgi = bolumBilgi(k);
    if (!(k.type === 'series' || bilgi.sezon)) { tekler.push({ kart: kayitKarti(k), inen: k.durum === 'iniyor' }); continue; }
    const anahtar = String(k.contentId || bilgi.dizi).split(':')[0] || bilgi.dizi;
    if (!gruplar.has(anahtar)) gruplar.set(anahtar, { anahtar, ad: bilgi.dizi, poster: afisBul(k), bolumler: [] });
    const g = gruplar.get(anahtar);
    g.poster ||= afisBul(k);
    g.bolumler.push({ k, bilgi });
  }
  // Şu an inenler (en az bir bölümü "iniyor" olan dizi ya da film) listenin en üstünde; gerisi eski sırasıyla (kararlı sıralama).
  const hepsi = [...gruplar.values()].map((g) => ({ kart: grupKarti(g), inen: g.bolumler.some((b) => b.k.durum === 'iniyor') })).concat(tekler);
  return hepsi.sort((x, y) => Number(y.inen) - Number(x.inen)).map((x) => x.kart);
}

// Açık dizi kartları (2 sn'lik yenilemede kapanmasın).
const acik = new Set();

async function topluIslem(yol, ks) {
  for (const k of ks) await api(`/api/indirme/${yol}`, { method: 'POST', body: { id: k.id } }).catch(() => {});
  yenile();
}

function grupKarti(g) {
  g.bolumler.sort((x, y) => x.bilgi.sezon - y.bilgi.sezon || x.bilgi.bolum - y.bilgi.bolum);
  const ks = g.bolumler.map((b) => b.k);
  const toplam = ks.reduce((t, k) => t + (k.boyut || 0), 0);
  const inen = ks.reduce((t, k) => t + Math.min(k.inen || 0, k.boyut || k.inen || 0), 0);
  const yuzde = toplam ? Math.round((inen / toplam) * 100) : 0;
  const sayi = (d) => ks.filter((k) => k.durum === d).length;
  const ozet = [`${ks.length} bölüm`, sayi('bitti') ? `${sayi('bitti')} hazır` : null, sayi('iniyor') ? `${sayi('iniyor')} iniyor` : null,
    sayi('kuyrukta') ? `${sayi('kuyrukta')} sırada` : null, sayi('duraklatildi') ? `${sayi('duraklatildi')} duraklatıldı` : null,
    sayi('hata') ? `${sayi('hata')} hata` : null, toplam ? `${boyut(inen)} / ${boyut(toplam)}` : null].filter(Boolean).join(' · ');
  const bekleyen = ks.filter((k) => k.durum !== 'bitti');
  const calisan = ks.filter((k) => k.durum === 'iniyor' || k.durum === 'kuyrukta');
  const durak = ks.filter((k) => k.durum === 'duraklatildi' || k.durum === 'hata');
  const toplu = [];
  // Tek düğme: bir şey iniyor/sırada ise "Hepsini duraklat", hepsi durmuşsa "Hepsini sürdür".
  if (calisan.length) toplu.push(el('button', { type: 'button', onclick: () => topluIslem('duraklat', calisan) }, 'Hepsini duraklat'));
  else if (durak.length) toplu.push(el('button', { type: 'button', onclick: () => topluIslem('surdur', durak) }, 'Hepsini sürdür'));
  if (bekleyen.length > 1) {
    toplu.push(el('button', {
      type: 'button',
      class: 'danger',
      onclick: async () => { if (await onayla(`${g.ad}: bekleyen ${bekleyen.length} indirme iptal edilip yarım dosyalar silinsin mi?`)) topluIslem('sil', bekleyen); },
    }, 'Bekleyenleri iptal et'));
  }
  const aktifKayitlar = ks.filter((k) => k.durum === 'iniyor');
  const grupHiz = canliHiz(`g|${g.anahtar}`, ks.reduce((t, k) => t + (k.inen || 0), 0));
  for (const k of ks) k.canliHiz = canliHiz(`k|${k.id}`, k.inen || 0); // bölüm satırı bunu okur
  const canli = aktifKayitlar.length > 0 && grupHiz > 0;
  const kapsayici = el('div', { class: `dl-kart dl-grup ${sayi('iniyor') ? 'iniyor' : ''} ${canli ? 'canli' : ''} ${acik.has(g.anahtar) ? 'acik' : ''}` });
  const ust = el('div', { class: 'dl-grup-ust', title: 'Bölümleri göster/gizle', onclick: (e) => {
    if (e.target.closest('button, a')) return;
    kapsayici.classList.toggle('acik');
    if (kapsayici.classList.contains('acik')) acik.add(g.anahtar); else acik.delete(g.anahtar);
  } },
      el('div', { class: 'dl-afis' }, g.poster
        ? el('img', { src: g.poster, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(afisYok()) })
        : afisYok()),
      el('div', { class: 'dl-govde' },
        el('div', { class: 'dl-ad', title: g.ad }, g.ad),
        aktifKayitlar.length
          ? el('div', { class: `dl-canli-etiket${canli ? ' var' : ''}` }, el('span', { class: 'dl-nabiz' }), canli ? `Şu an iniyor · ${grupHiz.toFixed(1)} Mbps` : 'İniyor ama veri gelmiyor (bekleniyor)')
          : null,
        el('div', { class: 'dl-alt' }, ozet),
        bekleyen.length ? el('div', { class: 'cubuk' }, el('div', { style: `width:${yuzde}%` })) : null,
        el('div', { class: 'dl-dugmeler' }, ...toplu)),
      el('div', { class: 'dl-ok', 'aria-hidden': 'true' }, '▾'));
  kapsayici.append(ust, el('div', { class: 'dl-bolumler' }, ...g.bolumler.map(({ k, bilgi }) => bolumSatiri(k, bilgi))));
  return kapsayici;
}

function bolumSatiri(k, bilgi) {
  const yuzde = yuzdeGoster(k);
  return el('div', { class: `dl-bolum ${k.durum === 'iniyor' ? 'iniyor' : ''} ${k.durum === 'iniyor' && k.canliHiz > 0 ? 'canli' : ''}` },
    el('div', { class: 'dl-bolum-bilgi' },
      el('div', { class: 'dl-bolum-ad', title: bilgi.etiket }, bilgi.etiket),
      el('div', { class: 'dl-alt' }, kayitAlt(k)),
      yuzde === null ? null : el('div', { class: 'cubuk' }, el('div', { style: `width:${yuzde}%` }))),
    el('div', { class: 'dl-dugmeler' }, ...kayitDugmeleri(k)));
}

function aramaKarti(a) {
  return kart({
    poster: a.poster, ad: a.ad,
    alt: `${ARAMA[a.durum] || a.durum}${a.hata && a.durum !== 'bulunamadi' ? ` · ${a.hata}` : ''}`,
    dugmeler: [el('button', { type: 'button', onclick: () => islem('otomatik/iptal', { anahtar: a.anahtar }) }, 'İptal')],
  });
}

// Kartlar sütunlara sırayla dağıtılır: biri açılıp uzayınca öbürleri yerinden oynamaz
// (CSS ızgarasında aynı satırdaki kartlar uzun olana göre aşağı itiliyordu).
function sutunSayisi() {
  if (gorunum === 'liste') return 1;
  const w = $('#dl-icerik').clientWidth || window.innerWidth;
  const en = Math.min(520, Math.max(300, window.innerWidth * 0.28));
  return Math.max(1, Math.floor((w + 16) / (en + 16)));
}
function sutunlar(kartlar) {
  // En çok 2 sütun; tek kart varsa tam genişlikte (dar kartta sıkışık durmasın).
  const n = Math.max(1, Math.min(2, kartlar.length, sutunSayisi()));
  const kutu = el('div', { class: 'dl-izgara' });
  kutu.style.setProperty('--sutun', String(n));
  const cols = Array.from({ length: n }, () => el('div', { class: 'dl-sutun' }));
  kartlar.forEach((k, i) => cols[i % n].append(k));
  kutu.append(...cols);
  return kutu;
}

function bolum(baslik, kartlar) {
  return kartlar.length
    ? el('section', { class: 'satir' }, el('div', { class: 'satir-baslik' }, el('h2', { text: baslik })), sutunlar(kartlar))
    : null;
}

function ciz() {
  const { kayitlar, arama } = veri;
  eksikAfisiTamamla(kayitlar);
  const biten = kayitlar.filter((k) => k.durum === 'bitti');
  // Dizide bir bölüm bile inmiyorsa dizinin bütün bölümleri (inmişler dahil) üstteki bölümde, tek kartta.
  const anahtarDi = (k) => (k.type === 'series' || bolumBilgi(k).sezon ? String(k.contentId || bolumBilgi(k).dizi).split(':')[0] : null);
  const aktifDizi = new Set(kayitlar.filter((k) => k.durum !== 'bitti').map(anahtarDi).filter(Boolean));
  const aktifGrup = kayitlar.filter((k) => k.durum !== 'bitti' || aktifDizi.has(anahtarDi(k)));
  const bitenGrup = kayitlar.filter((k) => !aktifGrup.includes(k));
  const toplam = biten.reduce((t, k) => t + (k.boyut || 0), 0);
  $('#dl-ozet').replaceChildren(
    el('span', { class: 'dl-chip' }, `${kayitlar.filter((k) => k.durum === 'iniyor').length} iniyor`),
    el('span', { class: 'dl-chip' }, `${kayitlar.filter((k) => k.durum === 'kuyrukta').length + arama.length} sırada`),
    el('span', { class: 'dl-chip' }, `${biten.length} hazır · ${boyut(toplam)}`));
  const parcalar = [
    bolum('İniyor ve sırada', [...grupla(aktifGrup), ...arama.map(aramaKarti)]),
    bolum('İndirilenler', grupla(bitenGrup)),
  ].filter(Boolean);
  $('#dl-icerik').replaceChildren(...(parcalar.length
    ? parcalar
    : [el('div', { class: 'dl-bos' },
      el('p', { text: 'Henüz indirme yok.' }),
      el('p', { class: 'muted', text: 'Film ya da bölümün yanındaki ↓ düğmesine basınca arka planda iner, sonra internetsiz de, beklemeden de açılır.' }),
      el('a', { class: 'button primary', href: '/ana' }, 'Ana sayfaya git'))]));
}

function ayarlariGoster() {
  const es = $('#dl-es-zamanli');
  if (document.activeElement !== es) {
    if (!es.options.length) {
      for (let i = 1; i <= (veri.enCokEsZamanli || 5); i++) es.append(el('option', { value: String(i) }, String(i)));
      es.addEventListener('change', () => islem('eszamanli', { sayi: Number(es.value) }));
    }
    es.value = String(veri.esZamanli || 1);
  }
  const hiz = $('#dl-hiz-limit');
  if (!hiz.dataset.bagli) {
    hiz.dataset.bagli = '1';
    hiz.addEventListener('change', () => islem('hiz-limiti', { mbps: hiz.value === '' ? 0 : Number(hiz.value) }));
  }
  if (document.activeElement !== hiz) hiz.value = veri.hizLimitiMbps ? String(veri.hizLimitiMbps) : '';
  const iz = $('#dl-izlerken');
  if (!iz.dataset.bagli) {
    iz.dataset.bagli = '1';
    iz.addEventListener('change', () => islem('izlerken-duraklat', { acik: iz.checked }));
  }
  if (document.activeElement !== iz) iz.checked = Boolean(veri.izlerkenDuraklat);
  $('#dl-yer').textContent = veri.kokKlasor || veri.klasor || '';
}

async function yenile() {
  try {
    veri = await api('/api/indirme');
    veri.arama ||= [];
  } catch { return; }
  ayarlariGoster();
  anlikGoster();
  ciz();
}

// Hız limitinin yanında: şu an bütün indirmelerin toplam hızı (iki yoklama arasındaki bayt farkından).
function anlikGoster() {
  const kap = $('#dl-anlik');
  if (!kap) return;
  const toplam = (veri.kayitlar || []).reduce((t, k) => t + (k.inen || 0), 0);
  const hiz = canliHiz('toplam', toplam);
  const iniyor = (veri.kayitlar || []).some((k) => k.durum === 'iniyor');
  $('#dl-anlik-deger').textContent = `${(iniyor ? hiz : 0).toFixed(1)} Mbps`;
  kap.classList.toggle('var', iniyor && hiz > 0);
}

$('#dl-klasor').addEventListener('click', async () => {
  // Masaüstü uygulamasında klasör seçme penceresi; tarayıcıda yol elle yazılıyor.
  const klasor = window.kabuk?.klasorSec
    ? await window.kabuk.klasorSec('İndirilenler için klasör seç')
    : await sor('İndirme klasörü (ör. E:\\Filmler). İçinde "BirlikteIzle-indirilen" klasörü açılır.');
  if (!klasor) return;
  const r = await api('/api/indirme/klasor', { method: 'POST', body: { klasor } }).catch((err) => ({ error: err.message }));
  const not = $('#dl-not');
  not.hidden = false;
  not.textContent = r.error
    ? `Klasör ayarlanamadı: ${r.error === 'yazilamiyor' ? 'bu klasöre yazılamıyor' : r.error}`
    : `Yeni indirmeler buraya inecek: ${r.klasor}. İnmiş dosyalar eski yerinde kalır.`;
  yenile();
});

export const hazir = yenile();
setInterval(() => { if (!document.hidden) yenile(); }, 2000);

let sonSutun = 0;
window.addEventListener('resize', () => { if (sutunSayisi() !== sonSutun) { sonSutun = sutunSayisi(); ciz(); } });
