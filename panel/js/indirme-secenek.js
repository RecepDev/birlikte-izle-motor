// İndirme seçenekleri: kalite, boyut, HDR, dil, Türkçe altyazı, Blu-ray.
// - Ayarlar > İndirme bölümünde kalıcı ayar (değişince kendiliğinden kaydolur) + "indirirken sor" anahtarı.
// - İndirmeye basınca (ayar açıksa) soru penceresi; kapalıysa kayıtlı seçenekler sessizce uygulanır.
// Sunucu: GET/POST /api/indirme/secenek, POST /api/indirme/otomatik { items, secenek? }.
import { api, el } from './api.js';
import { onayla, bildir } from '/js/diyalog.js';
import { DILLER, dilAdi } from './diller.js';

const ALANLAR = [
  ['kalite', 'Kalite', 'Hangi çözünürlük indirilsin', [['', 'Otomatik (tercih edilen kalite)'], ['2160p', '4K (2160p)'], ['1080p', '1080p'], ['720p', '720p'], ['480p', '480p']]],
  ['boyut', 'Boyut', 'Aynı kalitede küçük dosya mı, büyük (daha iyi görüntü) mü', [['fark', 'Fark etmez (en çok kaynaklı)'], ['kucuk', 'En küçük dosya'], ['buyuk', 'En büyük dosya']]],
  ['hdr', 'HDR', 'HDR / Dolby Vision', [['fark', 'Fark etmez'], ['olsun', 'HDR olsun'], ['olmasin', 'HDR olmasın (SDR)']]],
  ['trAltyazi', 'Türkçe altyazı', 'Dosyanın içinde Türkçe altyazı belirtilen kaynaklar', [['fark', 'Fark etmez'], ['olsun', 'Türkçe altyazı olsun']]],
  ['bluray', 'Blu-ray', 'Blu-ray / Remux kaynak', [['fark', 'Fark etmez'], ['olsun', 'Blu-ray olsun'], ['olmasin', 'Blu-ray olmasın']]],
];

let kayitli = null;
// Favori diller sunucu eski sürümdeyse sunucuda tutulamaz (yeni alanı bilmiyor): tarayıcıda da yedeklenir.
const yerelFavori = () => { try { const v = JSON.parse(localStorage.getItem('favoriDiller') || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } };
export async function seceneklerAl() {
  try { kayitli = await api('/api/indirme/secenek'); } catch { /* sunucu yoksa eski */ }
  const d = kayitli || { sor: true, kalite: '', boyut: 'fark', boyutMaxGb: null, hdr: 'fark', dil: 'fark', trAltyazi: 'fark', bluray: 'fark' };
  return { ...d, favoriDiller: Array.isArray(d.favoriDiller) ? d.favoriDiller : (yerelFavori() || ['tr', 'en']) };
}
export const seceneklerKaydet = (kismi) => {
  if (Array.isArray(kismi.favoriDiller)) { try { localStorage.setItem('favoriDiller', JSON.stringify(kismi.favoriDiller)); } catch { /* yok */ } }
  return api('/api/indirme/secenek', { method: 'POST', body: kismi }).then((s) => { kayitli = s; return s; });
};

// Form: { kap, oku() }. sinif: 'ayar' (Ayarlar satırları) ya da 'soru' (pencere ızgarası).
function form(deger, sinif, degisince = null) {
  const kontroller = {};
  const satirlar = ALANLAR.map(([ad, baslik, ipucu, secenekler]) => {
    const sec = el('select', { class: 'sec-kontrol' }, ...secenekler.map(([v, e]) => el('option', { value: v }, e)));
    sec.value = deger[ad] ?? secenekler[0][0];
    sec.addEventListener('change', () => degisince?.());
    kontroller[ad] = sec;
    return { ad, baslik, ipucu, kontrol: sec };
  });
  const max = el('input', { type: 'number', class: 'sec-kontrol', min: '1', max: '2000', step: '1', placeholder: 'sınırsız', value: deger.boyutMaxGb ?? '' });
  max.addEventListener('change', () => degisince?.());
  satirlar.splice(2, 0, { ad: 'boyutMaxGb', baslik: 'Boyut üst sınırı (GB)', ipucu: 'Bundan büyük dosyalar elenir (uygun olan yoksa sınır yok sayılır)', kontrol: max });

  // Dil: favori dillerinden BİRDEN ÇOK seçilebilir (hiçbiri seçili değilse fark etmez). Favori yoksa bütün diller.
  const favoriler = deger.favoriDiller?.length ? deger.favoriDiller : DILLER.map((d) => d.kod);
  const secili = new Set(Array.isArray(deger.diller) && deger.diller.length ? deger.diller : (deger.dil && deger.dil !== 'fark' ? [deger.dil] : []));
  const dilKodlari = [...new Set([...favoriler, ...secili])]; // kayıtlı dil favori olmasa da listede kalsın
  const dilCipler = el('div', { class: 'dil-cipler dil-sec' }, ...dilKodlari.map((k) => {
    const c = el('button', { type: 'button', class: `kut-chip${secili.has(k) ? ' aktif' : ''}`, 'aria-pressed': String(secili.has(k)) }, dilAdi(k));
    c.addEventListener('click', () => {
      if (secili.has(k)) secili.delete(k); else secili.add(k);
      c.classList.toggle('aktif', secili.has(k));
      c.setAttribute('aria-pressed', String(secili.has(k)));
      degisince?.();
    });
    return c;
  }));
  satirlar.splice(3, 0, { ad: 'dil', baslik: 'Dil', ipucu: 'Ses dili: istediğin kadar seç (favorilerin Ayarlar > İndirme içinde). Hiçbiri seçili değilse fark etmez.', kontrol: dilCipler, kutu: true });

  const kap = el('div', { class: `sec-form sec-${sinif}` }, ...satirlar.map((s) => (sinif === 'ayar'
    ? el('div', { class: 'ayar-satir' }, el('div', {}, s.baslik, el('small', { text: s.ipucu })), s.kontrol)
    : el(s.kutu ? 'div' : 'label', { class: 'sec-satir' }, el('span', { class: 'sec-ad', title: s.ipucu }, s.baslik), s.kontrol))));
  return {
    kap,
    oku: () => ({
      ...Object.fromEntries(Object.entries(kontroller).map(([ad, k]) => [ad, k.value])),
      boyutMaxGb: max.value === '' ? null : Number(max.value),
      diller: [...secili],
      dil: [...secili][0] || 'fark', // eski sunucu yalnız tek dil biliyor
    }),
  };
}

// Ayarlar sayfası: hedef kapsayıcıya "indirirken sor" anahtarı + seçenekler. Değişiklik anında kaydolur.
export async function ayarlarCiz(kap) {
  const d = await seceneklerAl();
  const sor = el('input', { type: 'checkbox', checked: d.sor });
  const f = form(d, 'ayar', () => seceneklerKaydet(f.oku()));
  sor.addEventListener('change', () => seceneklerKaydet({ sor: sor.checked }));
  // Bütün diller: tıklayarak favori yap / çıkar. Favoriler indirme penceresindeki Dil listesini oluşturur.
  const favoriler = new Set(d.favoriDiller || []);
  const cipler = el('div', { class: 'dil-cipler' }, ...DILLER.map((x) => {
    const c = el('button', { type: 'button', class: `kut-chip${favoriler.has(x.kod) ? ' aktif' : ''}`, title: favoriler.has(x.kod) ? 'Favoriden çıkar' : 'Favori yap' }, x.ad);
    c.addEventListener('click', async () => {
      if (favoriler.has(x.kod)) favoriler.delete(x.kod); else favoriler.add(x.kod);
      await seceneklerKaydet({ favoriDiller: [...favoriler], });
      ayarlarCiz(kap);
    });
    return c;
  }));
  const izlSec = el('select', { class: 'sec-kontrol' },
    el('option', { value: 'sor' }, 'Her seferinde sor'), el('option', { value: 'evet' }, 'Hepsini indir'), el('option', { value: 'hayir' }, 'İzlenmişleri atla'));
  izlSec.value = izlenmisModu();
  izlSec.addEventListener('change', () => izlenmisModuYaz(izlSec.value));
  kap.replaceChildren(
    el('div', { class: 'ayar-satir' }, el('div', {}, 'Toplu indirmede izlenmiş bölümler', el('small', { text: 'Sezon ya da tüm sezonlar indirilirken izlenmiş bölüm varsa ne yapılsın.' })), izlSec),
    el('div', { class: 'ayar-satir' }, el('div', {}, 'İndirmeye basınca seçenekleri sor', el('small', { text: 'Kapalıysa aşağıdaki seçenekler sormadan uygulanır.' })), sor),
    el('div', { class: 'ayar-satir dil-satir' }, el('div', {}, 'Favori diller', el('small', { text: 'Bütün dillerden istediklerini favori yap. İndirme seçeneklerindeki Dil listesinde yalnız favorilerin görünür.' })), cipler),
    f.kap);
}

// Soru penceresi. Dönen: { secenek } | null (vazgeçildi). `varsayilanYap` seçenekleri kalıcı kaydeder, `sorma` soruyu kapatır.
function sor({ baslik, ozet, deger }) {
  return new Promise((coz) => {
    const f = form(deger, 'soru');
    const varsayilan = el('input', { type: 'checkbox' });
    const sorma = el('input', { type: 'checkbox' });
    const iptal = el('button', { type: 'button', class: 'sec-dugme' }, 'Vazgeç');
    const tamam = el('button', { type: 'button', class: 'sec-dugme birincil' }, 'İndir');
    const dlg = el('dialog', { class: 'sec-dialog' },
      el('h2', { text: 'İndirme seçenekleri' }),
      el('p', { class: 'sec-ozet', text: ozet || baslik }),
      f.kap,
      el('label', { class: 'sec-onay' }, varsayilan, ' Bunları varsayılan yap'),
      el('label', { class: 'sec-onay' }, sorma, ' Bir daha sorma (Ayarlar > İndirme\'den açılır)'),
      el('div', { class: 'sec-alt' }, iptal, tamam));
    const bitir = (sonuc) => { dlg.close(); dlg.remove(); coz(sonuc); };
    iptal.addEventListener('click', () => bitir(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); bitir(null); });
    tamam.addEventListener('click', async () => {
      const secenek = f.oku();
      if (varsayilan.checked || sorma.checked) await seceneklerKaydet({ ...secenek, ...(sorma.checked ? { sor: false } : {}) }).catch(() => {});
      bitir({ secenek });
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// Tek giriş: arka planda indirmeyi başlatır. items: [{ type, id }]. Seçenek sorusu ayara göre.
// Dönen: true = istek gitti, false = vazgeçildi/hata.
// Toplu indirmede izlenmiş bölümler: 'sor' (varsayılan) | 'evet' (hepsini indir) | 'hayir' (izlenmişleri atla).
// Tarayıcıda/uygulamada tutuluyor (sunucu sürümünden bağımsız). Ayarlar > İndirme'den değişir.
export const izlenmisModu = () => { try { return localStorage.getItem('indirIzlenmis') || 'sor'; } catch { return 'sor'; } };
const izlenmisModuYaz = (m) => { try { localStorage.setItem('indirIzlenmis', m); } catch { /* yok */ } };

// items içindeki izlenmiş bölümlerin kimlikleri (dizi başına bölüm listesinden: elle işaretli + izlenen geçmişi).
async function izlenmisBul(items) {
  const diziler = [...new Set(items.filter((x) => x.type === 'series').map((x) => String(x.id).split(':')[0]))];
  const izlenen = new Set();
  await Promise.all(diziler.map(async (imdb) => {
    const liste = await api(`/api/series/${encodeURIComponent(imdb)}/episodes`).catch(() => []);
    for (const b of liste) if (b.watched) izlenen.add(`${imdb}:${b.season}:${b.episode}`);
  }));
  return new Set(items.filter((x) => izlenen.has(x.id)).map((x) => x.id));
}

export async function indirmeIstegi(items, aciklama = '', toplu = null) {
  // Toplu indirmede (birden çok bölüm) izlenmiş olanlar: ayara göre sor / hepsini indir / atla.
  if (items.length > 1) {
    const izl = await izlenmisBul(items);
    if (izl.size) {
      const mod = izlenmisModu();
      const dahil = mod === 'sor'
        ? await onayla(`${aciklama ? `${aciklama}: ` : ''}${izl.size} izlenmiş bölüm var. İzlenmişler de indirilsin mi?`, { tamam: 'Evet, hepsini indir', iptal: 'Hayır, izlenmişleri atla' })
        : mod === 'evet';
      if (!dahil) items = items.filter((x) => !izl.has(x.id));
      if (!items.length) { bildir('İndirilecek izlenmemiş bölüm kalmadı.'); return false; }
    }
  }
  const d = await seceneklerAl();
  let secenek = null;
  if (d.sor) {
    const s = await sor({ baslik: aciklama, ozet: aciklama ? `${aciklama} için seçenekler` : '', deger: d });
    if (!s) return false;
    secenek = s.secenek;
  } else if (items.length > 1 && !await onayla(`${aciklama} arka planda indirilsin mi?\nKaynak her bölüm için otomatik seçilir; bölümler sırayla iner, disk alanı kullanır.`)) {
    return false;
  }
  let hata = null;
  for (let i = 0; i < items.length; i += 80) {
    const r = await api('/api/indirme/otomatik', { method: 'POST', body: { items: items.slice(i, i + 80), ...(secenek ? { secenek } : {}), ...(toplu ? { toplu } : {}) } }).catch((err) => ({ error: err.message }));
    if (r?.error) { hata = r.error; break; }
  }
  if (hata) { bildir(`İndirme eklenemedi: ${hata}`); return false; }
  // Sunucu eski sürümdeyse toplu türünü kaydetmez: afiş dairesi (S2 / A) bunu tarayıcıda da hatırlasın.
  if (toplu) {
    try {
      const harita = JSON.parse(localStorage.getItem('indirmeToplu') || '{}');
      for (const { id } of items) harita[id] = toplu;
      const anahtarlar = Object.keys(harita);
      for (const k of anahtarlar.slice(0, Math.max(0, anahtarlar.length - 3000))) delete harita[k];
      localStorage.setItem('indirmeToplu', JSON.stringify(harita));
    } catch { /* yok */ }
  }
  return true;
}
