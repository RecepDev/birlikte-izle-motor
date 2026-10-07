import { api, apiStream, el, $, formatSize } from './api.js';
import { browserCodecs } from './codecs.js';
import { otomatikSec, hafizaOnce, grupAdi } from './kaynak-sec.js';

// Can this browser show the picture without re-encoding (original quality)?
const caps = browserCodecs(document.createElement('video'));
const RISK_CODEC = { HEVC: 'hevc', 'Dolby Vision': 'hevc', AV1: 'av1' };
function pictureNote(s) {
  if (!s.videoRisk) return null;
  const ok = caps.videoCodecs.includes(RISK_CODEC[s.videoRisk]);
  return ok
    ? { ok, text: ` · ✅ ${s.videoRisk}: bu tarayıcı açabiliyor (orijinal kalite)` }
    : { ok, text: ` · ⚠️ ${s.videoRisk}: bu tarayıcı açamıyor (görüntü için dönüştürme gerekir, kalite düşer)` };
}

const DEBRID_WARNING = 'Bu bir doğrudan link (ör. Real-Debrid).\n\n'
  + 'Linkte debrid hesabının anahtarı var: arkadaşların senin hesabını kullanır. '
  + 'Real-Debrid farklı IP\'lerden aynı anda kullanımı ban sebebi sayabilir.\n\nYine de bu stream ile oda açılsın mı?';

const params = new URLSearchParams(location.search);
const type = params.get('type');
const id = params.get('id');
let streams = [];
let loadDone = false;
let addonsReplied = 0;
let retrying = false;
let refreshing = false;
// Kalite filtresi (seçim hatırlanıyor). "Diğer": 480p ve altı / bilinmeyen.
const QUALITIES = ['2160p', '1080p', '720p'];
let qualityFilter = localStorage.getItem('odaAcKalite') || '';
const qualityOf = (s) => (QUALITIES.includes(s.quality) ? s.quality : 'diger');
// Liste ve denetim sırası: önce 4K, aynı kalitede çok kaynaklı önce.
// Tercih edilen kalite (odada seçiliyor) en üstte, sonra 4K, 1080p, 720p.
let tercihKalite = null;
const siraQ = (s) => {
  if (tercihKalite && s.quality === tercihKalite) return -1;
  const i = QUALITIES.indexOf(s.quality);
  return i < 0 ? 9 : i;
};
api('/api/tercih').then((t) => { tercihKalite = t?.kalite || null; render(); }).catch(() => {});
const siraliStream = (a, b) => siraQ(a) - siraQ(b) || (Number(b.seeders) || 0) - (Number(a.seeders) || 0);

// Bir addon (yeniden) cevap verince o addon'un eski sonuçlarının yerini alıyor.
function addonReplied(line) {
  streams = streams.filter((s) => s.addonName !== line.addonName);
  if (!line.error) streams.push(...line.streams);
}

function renderErrors(errors) {
  const box = $('#errors');
  if (!errors.length) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(
    `Cevap vermeyen addon'lar: ${errors.map((e) => `${e.addonName} (${e.message})`).join(', ')} `,
    el('button', { type: 'button', text: retrying ? '↻ Deneniyor… (tekrar basılabilir)' : '↻ Tekrar dene', onclick: () => retryFailed(errors) }),
  );
  box.hidden = false;
}

// Re-asks only the addons that failed, keeping whatever already succeeded —
// a full reload used to throw away a working addon's results too just
// because a different one didn't answer.
async function retryFailed(errors) {
  retrying = true;
  renderErrors(errors);
  const names = errors.map((e) => e.addonName);
  await apiStream(`/api/streams?${new URLSearchParams({ type, id, retry: names.join(',') })}`, (line) => {
    if (line.type === 'addon') {
      addonsReplied += 1;
      addonReplied(line);
      render();
    } else if (line.type === 'done') {
      retrying = false;
      renderErrors(line.errors);
    }
  });
}

// Her zaman basılabilir: addon'lar yavaş kaldıysa ya da eksik geldiyse hepsini yeniden sorar.
// Mevcut liste silinmiyor; cevap gelen addon'un sonuçları yenileriyle değişiyor.
async function refreshAll() {
  refreshing = true;
  renderRefresh();
  try {
    await apiStream(`/api/streams?${new URLSearchParams({ type, id, retry: '*' })}`, (line) => {
      if (line.type === 'addon') {
        addonReplied(line);
        render();
      } else if (line.type === 'done') {
        loadDone = true;
        renderErrors(line.errors);
        render();
      }
    });
  } finally {
    refreshing = false;
    renderRefresh();
  }
}
function renderRefresh() {
  $('#refresh-addons').textContent = refreshing ? '↻ Aranıyor… (tekrar basılabilir)' : "↻ Addon'ları tekrar ara";
}

async function createRoom(stream, button, { oto = false } = {}) {
  otoDurdur();
  if (!oto) otoIptal = true; // elle seçildi: otomatik devre dışı
  if (stream.kind === 'http' && !confirm(DEBRID_WARNING)) return;
  button.disabled = true;
  olusturuluyor = true;
  button.textContent = 'Oda açılıyor…';
  try {
    const olcumler = [...new Set([...sonuclar.keys(), ...enIyi.keys()])]
      .map((h) => ({ infoHash: h, ...(sonuclar.get(h) || enIyi.get(h)) }));
    const res = await api('/api/rooms', { method: 'POST', body: { type, id, streamId: stream.streamId, olcumler } });
    // Otomatik modda oda açılınca video da kendiliğinden başlasın (oda sayfası "oto=1"e bakıyor).
    if (oto) res.roomUrl += '&oto=1';
    if ($('#masaustu').checked) {
      // Şemayı masaüstü uygulaması kendine kaydediyor. Kurulu değilse tarayıcı bir şey
      // yapmaz, o yüzden oda linkini de gösteriyoruz.
      location.href = `birlikteizle://${encodeURIComponent(res.roomUrl)}`;
      button.textContent = 'Uygulamada açılıyor…';
      $('#streams').replaceChildren(el('p', {}, 'Oda masaüstü uygulamasında açılıyor. Açılmadıysa: ',
        el('a', { href: res.roomUrl }, 'tarayıcıda aç')));
      return;
    }
    location.href = res.roomUrl;
  } catch (err) {
    olusturuluyor = false;
    otoHata = true;
    otoModGoster();
    alert(`Oda açılamadı: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Bununla oda aç';
  }
}

// Canlı denetim: Stremio'da açık torrent'lerin bağlı kişi sayısı ve hızı (3 sn'de bir).
// Sayfa açılınca en iyi 4 aday kendiliğinden denetleniyor; "Görünenleri denetle" ile daha fazlası.
let durum = {};
let olusturuluyor = false;
const denetleniyor = new Map(); // infoHash -> başlama zamanı
// Denetim sonucu belli olunca (bağlantı kuruldu ve hız ölçüldü: 12 sn; ya da 25 sn'de kimse
// yok) sonuç sabitleniyor ve torrent Stremio'da kapatılıyor: seçilmeyen kaynaklar hızı
// boşuna yemesin. Sonuç listede "denendi" olarak kalıyor.
const sonuclar = new Map(); // infoHash -> { peers, downMbps }
const enIyi = new Map(); // infoHash -> denetim sırasında görülen en yüksek değerler
async function durumYenile() {
  durum = await api('/api/torrent-durum').catch(() => ({}));
  for (const h of Object.keys(durum)) if (!denetleniyor.has(h)) denetleniyor.set(h, Date.now());
  for (const [h, d] of Object.entries(durum)) {
    if (sonuclar.has(h)) continue;
    const e = enIyi.get(h) || { peers: 0, downMbps: 0 };
    enIyi.set(h, { peers: Math.max(e.peers, d.peers), downMbps: Math.max(e.downMbps, d.downMbps), found: d.found });
    const sure = Date.now() - denetleniyor.get(h);
    if ((d.peers > 0 && sure > 12_000) || sure > 25_000) {
      sonuclar.set(h, enIyi.get(h));
      // Otomatik seçimin adaylarını boru hattı kendisi kapatıyor (bkz. otoDene): seçilen açık kalmalı.
      if (otoAdaylar.some((s) => s.infoHash === h)) continue;
      api('/api/torrent-kapat', { method: 'POST', body: { infoHash: h } }).catch(() => {});
    }
  }
  // Oda açılırken listeyi yeniden çizme: basılan düğmenin "açılıyor" hali kaybolmasın.
  if (!olusturuluyor) render();
}
setInterval(durumYenile, 3000);
function canliEtiket(s) {
  if (s.kind !== 'torrent') return null;
  const son = sonuclar.get(s.infoHash);
  if (son) {
    if (!son.peers) return el('span', { class: 'kind risk', text: ` · ⚠️ ${son.found ? `${son.found} adres bulundu ama ` : ''}kimseye bağlanılamadı (denendi)` });
    const iyi = son.peers >= 8 || son.downMbps >= 10;
    return el('span', { class: `kind ${iyi ? 'fine' : 'risk'}`, text: ` · 🧲 ${son.peers} kişi${son.downMbps ? ` · ↓ ${son.downMbps} Mbps` : ''} (denendi)` });
  }
  const d = durum[s.infoHash];
  if (!d) return null;
  const sure = Date.now() - (denetleniyor.get(s.infoHash) || Date.now());
  if (d.peers > 0) {
    const iyi = d.peers >= 8 || d.downMbps >= 10;
    return el('span', { class: `kind ${iyi ? 'fine' : 'risk'}`, text: ` · 🧲 ${d.peers} kişiye bağlandı${d.downMbps ? ` · ↓ ${d.downMbps} Mbps` : ''} (canlı)` });
  }
  return sure > 25_000
    ? el('span', { class: 'kind risk', text: ` · ⚠️ ${d.found ? `${d.found} adres bulundu ama ` : ''}kimseye bağlanılamadı` })
    : el('span', { class: 'kind', text: ' · ⏳ denetleniyor, kaynak aranıyor…' });
}
async function gorunenleriDenetle() {
  const q = $('#filter').value.trim().toLowerCase();
  const ids = [...streams].sort(siraliStream).filter((s) => s.kind === 'torrent' && !durum[s.infoHash] && !sonuclar.has(s.infoHash)
    && (!q || `${s.name} ${s.title} ${s.quality}`.toLowerCase().includes(q))
    && (!qualityFilter || qualityOf(s) === qualityFilter)).slice(0, 12).map((s) => s.streamId);
  if (!ids.length) return;
  await api('/api/torrent-denetle', { method: 'POST', body: { type, id, streamIds: ids } }).catch(() => {});
  durumYenile();
}

function render() {
  const q = $('#filter').value.trim().toLowerCase();
  renderQualityChips();
  const visible = streams.filter((s) => (!q || `${s.name} ${s.title} ${s.quality}`.toLowerCase().includes(q))
    && (!qualityFilter || qualityOf(s) === qualityFilter)).sort(siraliStream);
  const box = $('#streams');
  if (!streams.length) {
    box.replaceChildren(el('p', {
      class: 'muted',
      text: loadDone
        ? "Hiç stream bulunamadı. Panelde Torrentio gibi bir stream addon'u ekli ve açık mı?"
        : `Addon'lardan stream'ler alınıyor… (${addonsReplied} addon cevap verdi)`,
    }));
    return;
  }
  if (!visible.length) {
    box.replaceChildren(el('p', { class: 'muted', text: 'Bu filtreye uyan stream yok.' }));
    return;
  }
  const groups = new Map();
  for (const s of visible) {
    if (!groups.has(s.addonName)) groups.set(s.addonName, []);
    groups.get(s.addonName).push(s);
  }
  const searching = loadDone ? null : el('p', { class: 'muted small', text: `Diğer addon'lar aranıyor… (${addonsReplied} cevap verdi)` });
  const ul = el('ul', { class: 'streams' }, ...[...groups].flatMap(([addon, list]) => [
    el('h3', { text: `${addon} (${list.length})` }),
    ...list.map((s) => {
      const button = el('button', { type: 'button', class: 'primary', text: 'Bununla oda aç' });
      button.dataset.sid = s.streamId;
      button.addEventListener('click', () => createRoom(s, button));
      return el(
        'li',
        { class: 'item' },
        el('span', { class: 'q', text: s.quality || '?' }),
        el('div', { class: 'info' },
          el('div', { text: `${formatSize(s.sizeBytes)} ${s.title || s.name}`.trim() }),
          el('span', { class: 'kind', text: s.kind === 'torrent' ? '🧲 torrent' : '🔗 doğrudan link (debrid)' }),
          // Masaüstü uygulamasında (mpv) her biçim açılıyor: tarayıcı notları gereksiz.
          s.notWebReady && !kabuktayiz ? el('span', { class: 'kind', text: ' · tarayıcıda dönüştürme gerekebilir' }) : null,
          (() => {
            if (kabuktayiz) return null;
            const note = pictureNote(s);
            return note ? el('span', { class: `kind ${note.ok ? 'fine' : 'risk'}`, text: note.text }) : null;
          })(),
          // Açıklamalar simgenin üstünde (fareyle bekleyince), satırda yalnızca simge.
          s.hdr ? el('span', { class: 'kind ikon', title: `${s.hdr}: HDR olmayan ekranda karanlık görünebilir` }, ' · 🌗') : null,
          s.embeddedSubs ? el('span', { class: 'kind ikon', title: `Gömülü altyazı${s.embeddedSubs.langs.length ? `: ${s.embeddedSubs.langs.join(', ')}` : ''}` }, ' · 💬') : null,
          canliEtiket(s)),
        button,
      );
    }),
  ]));
  box.replaceChildren(...[searching, ul].filter(Boolean));
}

function renderQualityChips() {
  const counts = new Map();
  for (const s of streams) counts.set(qualityOf(s), (counts.get(qualityOf(s)) || 0) + 1);
  const chip = (value, label) => el('button', {
    type: 'button', class: `chip${qualityFilter === value ? ' active' : ''}`,
    text: value ? `${label} (${counts.get(value) || 0})` : `Tümü (${streams.length})`,
    onclick: () => {
      qualityFilter = value;
      localStorage.setItem('odaAcKalite', value);
      render();
    },
  });
  $('#quality-chips').replaceChildren(
    chip('', ''),
    ...QUALITIES.map((qv) => chip(qv, qv === '2160p' ? '4K' : qv)),
    chip('diger', 'Diğer'),
  );
}

// Geri: arama/bölüm listesine (geçmiş varsa oraya, yoksa arama sayfasına).
// Dizide: o dizinin sezon/bölüm listesine (arama sayfasında açık gelir). Filmde: aramaya.
const diziAdresi = () => `/ara?${new URLSearchParams({ dizi: String(id).split(':')[0], ad: $('#title').textContent.replace(/\s+S\d+E\d+.*$/, '').trim() })}`;
$('#geri').addEventListener('click', () => {
  if (type === 'series') location.href = diziAdresi();
  else if (history.length > 1 && document.referrer) history.back();
  else location.href = '/ara';
});
// Bölüm seçmeden dizinin kendisiyle gelindiyse (tüm sezonların kaynakları karışık listelenirdi):
// önce bölüm seçilsin.
if (type === 'series' && id && !String(id).includes(':')) location.replace(diziAdresi());
// Odadan "Geri" ile bu sayfaya dönülünce kaynak listesi (otomatik modda yeni oda!) değil,
// bölüm seçme/arama ekranı açılsın.
const geriGelindi = () => performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
function aramayaDon() {
  const ad = sessionStorage.getItem(`ad:${String(id).split(':')[0]}`) || '';
  location.replace(type === 'series'
    ? `/ara?${new URLSearchParams({ dizi: String(id).split(':')[0], ad })}`
    : '/ara');
}
if (geriGelindi()) aramayaDon();
window.addEventListener('pageshow', (e) => { if (e.persisted) aramayaDon(); });
$('#filter').addEventListener('input', render);
$('#refresh-addons').addEventListener('click', refreshAll);
$('#check-visible').addEventListener('click', gorunenleriDenetle);

const masaustuKutu = $('#masaustu');
// Zaten masaüstü kabuğundaysak seçenek anlamsız: oda aynı pencerede açılıyor.
const kabuktayiz = /Electron/.test(navigator.userAgent);
if (kabuktayiz) masaustuKutu.closest('.row').hidden = true;
masaustuKutu.checked = !kabuktayiz && localStorage.getItem('masaustuAc') === '1';
masaustuKutu.addEventListener('change', () => localStorage.setItem('masaustuAc', masaustuKutu.checked ? '1' : '0'));

// ---- Otomatik kaynak seçimi: addon'lar cevap verince (en geç 12 sn) tercih edilen kalitede en çok
// seed'li torrent seçilip (bkz. shared/kaynak-sec.js) 3 sn sonra oda açılıyor; bu arada iptal
// edilebilir. Altyazıyı oda sayfası kendisi seçiyor (Ayarlar > Altyazı).
// Açık/kapalı: masaüstü uygulamasında ana ekrandan (kabuk), tarayıcıda bu sayfadaki kutudan.
// Açıkken liste gizli, yalnızca botun ne yaptığı yazıyor; "İptal" listeyi gösterir.
const otoKutu = $('#oto-kaynak');
otoKutu.checked = window.kabuk?.otoKaynak ? window.kabuk.otoKaynak() : localStorage.getItem('otoKaynak') !== '0';
let otoHata = false;
function otoModGoster() {
  const acik = otoKutu.checked && !otoIptal && !otoHata;
  document.body.classList.toggle('oto-mod', acik);
  if (acik) $('#oto-bar').hidden = false;
}
function otoYaz(metin) {
  $('#oto-text').textContent = metin;
  $('#oto-simdi').hidden = !otoSayac;
}
otoKutu.addEventListener('change', () => {
  localStorage.setItem('otoKaynak', otoKutu.checked ? '1' : '0');
  window.kabuk?.otoKaynakYaz?.(otoKutu.checked);
  if (otoKutu.checked) {
    otoIptal = false;
    otoDene();
  } else otoDurdur();
});
// ---- Otomatik kaynak seçimi ---------------------------------------------------------------------------
// Ölçüm (2026-10-07, aynı torrent'ler yalnız magnet'le ve film bilgisi hazırken): ilk veri film bilgisinden
// bağımsız (medyan 8.4 / 8.6 sn). Belirleyen, kişilere bağlanıp onların veri göndermeye başlaması (paylaşan
// aynı anda birkaç kişiye gönderiyor, yeni gelene sırası gelince): torrent'ten torrent'e 0.6-31 sn, seed
// sayısı bunu iyi tahmin etmiyor. Bu yüzden:
// 1. Boru hattı: aynı anda 3 aday bağlanmayı deniyor (OTO_YUVA). 30 sn'de veri vermeyen bırakılıp yerine
//    sıradaki giriyor; sabit dalga yok (25 sn'de kesmek geç açılanı eliyordu, hepsini beklemek yuva boşa
//    bırakıyordu). 3'ten fazlası aynı anda bağlanmayı yavaşlatıyor (8'i birden: film bilgisi 1.6 -> 10 sn).
// 2. Doğrulama: ilk veri veren tek başına ölçülüyor (ötekilerin okuması durur, bağlantıları kalır; hat ona
//    kalır, dosyanın inmemiş bir yerinden okunur). Birlikte ölçülürken hat bölündüğü için hız düşük çıkıyordu.
// 3. Yeten (ihtiyaç x pay) bulununca hemen seçiliyor; yetmeyenin en iyisi açık tutulup boru hattı sürüyor.
// 4. Hattın taşıyamayacağı kaynak (ihtiyacı, şimdiye kadar tek başına görülen en yüksek hızdan fazla) sona.
let otoIptal = false;
let otoSayac = null;
let otoIlkCevap = null;
let otoSecim = null;
let otoAdaylar = []; // denemeye alınan adaylar, sırayla
const OTO_YUVA = 3;
const OTO_ERKEN = 3;
const ADAY_SURE_MS = 30_000; // adayın veri vermesi için tanınan süre (doğrulama sırasında işlemez)
const DOGRULAMA_MS = 8_000;
const OTO_IYI_MBPS = 15;
let sureSn = null; // içeriğin süresi (Cinemeta), meta satırıyla geliyor
let otoBaslangic = 0;
const aktif = new Map(); // infoHash -> { s, bas }: bağlanmayı deneyen adaylar
const olu = new Set(); // süresinde veri vermedi ya da tek başına yetmedi (bırakıldı)
const ilkVeri = new Map(); // infoHash -> keşifte görülen en yüksek hız (Mbps, veri geldiyse)
const dogrulanan = new Map(); // infoHash -> { mbps, peers }: tek başına ölçülen
let dogrulama = null; // { s, bas, ornekler: [{ t, mbps, peers }] }
let enIyiAcik = null; // yetmeyenlerin en iyisi: seçilme ihtimaline karşı açık
let canli = {}; // /api/torrent-durum son okuması (her saniye)
let canliIstek = false;
// Hat kapasitesi: şimdiye kadar tek başına görülen en yüksek hız (bu tarayıcıda/uygulamada saklanıyor).
let hatMbps = 0;
try { hatMbps = Number(localStorage.getItem('hatMbps')) || 0; } catch { /* */ }
const ihtiyacMbps = (s) => (sureSn && s.sizeBytes ? (s.sizeBytes * 8) / sureSn / 1e6 : null);
// "Yeterince hızlı": videonun ihtiyacı x pay. Pay arama uzadıkça iniyor (30 sn'ye kadar 1.5, 60 sn'ye kadar
// 1.25, sonra 1.1); hat 1.5 katını taşıyamıyorsa hattın verebileceği (en az 1.1). İhtiyacın altına inmiyor.
function payKatsayisi(s) {
  const sn = otoBaslangic ? (Date.now() - otoBaslangic) / 1000 : 0;
  let pay = sn < 30 ? 1.5 : sn < 60 ? 1.25 : 1.1;
  const ihtiyac = s && ihtiyacMbps(s);
  if (ihtiyac && hatMbps && ihtiyac * pay > hatMbps * 0.9) pay = Math.max(1.1, (hatMbps * 0.9) / ihtiyac);
  return Math.round(pay * 100) / 100;
}
function yeterliMbps(s) {
  const ihtiyac = ihtiyacMbps(s);
  return ihtiyac ? Math.max(4, ihtiyac * payKatsayisi(s)) : OTO_IYI_MBPS;
}
const hatTasimaz = (s) => hatMbps > 0 && (ihtiyacMbps(s) || 0) * 1.1 > hatMbps;
// Sıralama puanı: seed (sezon paketi geride) x yayın grubunun geçmişi x Türkçe altyazı x uyumluluk.
// - Grup: bütün içeriklerde iyi/kötü sayısı (bkz. src/kaynak-hafiza.js), 0.3-3 kat.
// - Dosyanın içinde Türkçe altyazı (sürüm adından): 1.5 kat.
// - Yalnız Dolby Vision (HDR10 yedeği yok): DV desteklemeyen ekranda renkler bozuk (mor/yeşil), 0.5 kat.
let kaynakOzet = { gruplar: {}, kotu: [] };
api('/api/kaynak-gruplari').then((o) => { if (o?.gruplar) kaynakOzet = o; }).catch(() => {});
const trAltyazi = (s) => (s.embeddedSubs?.langs || []).includes('Türkçe');
const dvYalniz = (s) => {
  const t = `${s.name || ''} ${s.title || ''}`;
  return /\b(dv|dovi)\b|dolby.?vision/i.test(t) && !/\bhdr(10)?(\+|plus)?\b/i.test(t);
};
function grupCarpani(s) {
  const g = kaynakOzet.gruplar?.[grupAdi(s)];
  return g ? Math.min(3, Math.max(0.3, (g.iyi + 1) / (g.kotu + 1))) : 1;
}
const otoPuan = (s) => (Number(s.seeders) || 0) * (s.pack ? 0.35 : 1) * grupCarpani(s) * (trAltyazi(s) ? 1.5 : 1) * (dvYalniz(s) ? 0.5 : 1);
// Aranan kalite: yalnız tercih edilen kalite. 4K seçiliyken 4K'lar arasından en iyisi bulunuyor, kendiliğinden
// 1080p'ye inilmiyor (kullanıcı, 2026-10-07). Alt kaliteye geçiş elle: "1080p'ye geç" düğmesi (otoKaliteZorla).
// O kalitede hiç kaynak yoksa otomatik seçimin kalitesi (bir alt, sonra üst).
const KALITE_SIRA = ['2160p', '1080p', '720p', '480p'];
const kaliteAdi = (q) => (q === '2160p' ? '4K' : q || '?');
let otoKaliteZorla = null;
// Dizide önceki bölümlerde iyi indiren kaynağın grubu: önce onlar deneniyor.
let kaynakHafiza = null;
if (type === 'series') api(`/api/kaynak-hafiza?${new URLSearchParams({ id })}`).then((h) => { kaynakHafiza = h; }).catch(() => {});
function otoArananKalite() {
  if (otoKaliteZorla) return otoKaliteZorla;
  const secilen = otomatikSec(streams, tercihKalite, { hafiza: kaynakHafiza });
  if (!secilen) return null;
  return tercihKalite && streams.some((s) => s.kind === 'torrent' && s.quality === tercihKalite) ? tercihKalite : secilen.quality;
}
function altKalite() {
  const i = KALITE_SIRA.indexOf(otoArananKalite());
  if (i < 0) return null;
  return KALITE_SIRA.slice(i + 1).find((q) => streams.some((s) => s.kind === 'torrent' && s.quality === q)) || null;
}
// Adaylar: aranan kalitedekiler puana göre. Hattın taşıyamayacağı ve odada daha önce bırakılanlar en sonda.
function otoAdayBul() {
  const kalite = otoArananKalite();
  if (!kalite) return [];
  const hepsi = hafizaOnce(streams.filter((s) => s.kind === 'torrent' && s.quality === kalite).sort((a, b) => otoPuan(b) - otoPuan(a)), kaynakHafiza);
  const kotu = new Set(kaynakOzet.kotu || []);
  const geri = (s) => kotu.has(s.infoHash) || hatTasimaz(s);
  return [...hepsi.filter((s) => !geri(s)), ...hepsi.filter(geri)];
}
function otoHavuz() {
  const denenen = new Set(otoAdaylar.map((s) => s.infoHash));
  return otoAdayBul().filter((s) => !denenen.has(s.infoHash));
}
const kapat = (ih) => api('/api/torrent-kapat', { method: 'POST', body: { infoHash: ih } }).catch(() => {});
function adayBaslat(s) {
  otoBaslangic ||= Date.now();
  otoAdaylar.push(s);
  aktif.set(s.infoHash, { s, bas: Date.now() });
  api('/api/torrent-denetle', { method: 'POST', body: { type, id, streamIds: [s.streamId] } }).catch(() => {});
}
function adayBirak(ih) {
  aktif.delete(ih);
  olu.add(ih);
  if (ih !== enIyiAcik) kapat(ih);
}
// Her saniye canlı durum: keşifteki adaylardan veri gelen kaydediliyor.
function canliOku() {
  if (canliIstek) return;
  canliIstek = true;
  api('/api/torrent-durum')
    .then((d) => {
      canli = d || {};
      for (const [ih, v] of Object.entries(canli)) {
        if (aktif.has(ih) && Number(v.downMbps) >= 0.5) ilkVeri.set(ih, Math.max(ilkVeri.get(ih) || 0, Number(v.downMbps)));
      }
    })
    .catch(() => {})
    .finally(() => { canliIstek = false; });
}
// Adayın ölçümü: tek başına doğrulandıysa o (asıl hız), yoksa keşifteki (yuvalar birlikteyken) değer.
function olcum(s) {
  const d = dogrulanan.get(s.infoHash);
  const peers = Number(canli[s.infoHash]?.peers) || 0;
  if (d) return { peers: Math.max(d.peers, peers), downMbps: d.mbps, dogrulandi: true };
  return { peers, downMbps: ilkVeri.get(s.infoHash) || 0 };
}
function dogrulamaBaslat(s) {
  dogrulama = { s, bas: Date.now(), ornekler: [] };
  api('/api/torrent-dogrula', { method: 'POST', body: { type, id, streamId: s.streamId } }).catch(() => {});
}
// Her saniye bir hız örneği; 3. saniyeden sonrasının ortalaması asıl hız. Son iki örnek çıtayı geçtiyse erken biter.
function dogrulamaIlerlet() {
  const d = dogrulama;
  const ih = d.s.infoHash;
  const gecen = Date.now() - d.bas;
  const v = canli[ih];
  if (v && (!d.ornekler.length || Date.now() - d.ornekler.at(-1).t >= 900)) {
    d.ornekler.push({ t: Date.now(), mbps: Number(v.downMbps) || 0, peers: Number(v.peers) || 0 });
  }
  const hedef = yeterliMbps(d.s);
  const son = d.ornekler.filter((o) => o.t - d.bas >= 3000);
  const ort = (l) => l.reduce((a, o) => a + o.mbps, 0) / l.length;
  const erken = son.length >= 2 && son.slice(-2).every((o) => o.mbps >= hedef);
  // Isınan kaynak (ölçüm: hız 12 -> 1 -> 38 Mbps, ancak 8. sn'de çıtayı geçti): 8 sn'de çıtanın %70'ine
  // varmış ve yükseliyorsa 14 sn'ye kadar beklenir.
  const sonIki = d.ornekler.slice(-2);
  const isiniyor = sonIki.length === 2 && sonIki[1].mbps >= hedef * 0.7 && sonIki[1].mbps > sonIki[0].mbps;
  if (!erken && (gecen < DOGRULAMA_MS || (isiniyor && gecen < 14_000))) {
    const grup = grupAdi(d.s);
    otoYaz(`🔎 Umut veren ${kaliteAdi(d.s.quality)} kaynak tek başına ölçülüyor: ${formatSize(d.s.sizeBytes)}${grup ? ` · ${grup}` : ''}`
      + ` — ↓ ${d.ornekler.at(-1)?.mbps ?? 0} / ${Math.round(hedef)} Mbps (${Math.max(1, Math.ceil((DOGRULAMA_MS - gecen) / 1000))} sn)`);
    return;
  }
  const mbps = Math.round((erken ? ort(son.slice(-2)) : son.length ? ort(son) : Math.max(0, ...d.ornekler.map((o) => o.mbps))) * 10) / 10;
  dogrulanan.set(ih, { mbps, peers: Math.max(0, ...d.ornekler.map((o) => o.peers)) });
  if (mbps > hatMbps) {
    hatMbps = mbps;
    try { localStorage.setItem('hatMbps', String(mbps)); } catch { /* */ }
  }
  aktif.delete(ih);
  dogrulama = null;
  // Doğrulama sırasında öteki adayların süresi işlemedi; okumaları durmuştu, kaldıkları yerden sürsün.
  for (const a of aktif.values()) a.bas += gecen;
  const devam = [...aktif.values()].map((a) => a.s.streamId);
  if (devam.length) api('/api/torrent-denetle', { method: 'POST', body: { type, id, streamIds: devam, bas: 32 * 1024 * 1024 } }).catch(() => {});
  if (mbps >= hedef) return; // seçim otoDene'de
  // Yetmedi: yetmeyenlerin en iyisi açık kalsın (adaylar biterse o seçilir), ötekisi kapansın.
  const oran = (h) => (dogrulanan.get(h)?.mbps || 0) / (ihtiyacMbps(otoAdaylar.find((s) => s.infoHash === h)) || OTO_IYI_MBPS / 1.5);
  if (!enIyiAcik || oran(ih) > oran(enIyiAcik)) {
    if (enIyiAcik) kapat(enIyiAcik);
    enIyiAcik = ih;
  } else kapat(ih);
  olu.add(ih);
}
// Denenen adaylar canlı: ✓ tek başına yetiyor · ✗ yetmedi / veri vermedi · 🔎 tek başına ölçülüyor ·
// … veri geliyor · ⏳ bağlanıyor. Kalite, boyut, grup, kişi, hız / çıta.
function otoListeYaz() {
  const kutu = $('#oto-liste');
  if (!kutu) return;
  const satirlar = otoAdaylar.map((s) => ({ s, o: olcum(s) }))
    .sort((a, b) => Number(b.o.dogrulandi || 0) - Number(a.o.dogrulandi || 0) || b.o.downMbps - a.o.downMbps)
    .slice(0, 8);
  kutu.hidden = !satirlar.length;
  kutu.replaceChildren(...satirlar.map(({ s, o }) => {
    const hedef = yeterliMbps(s);
    const ih = s.infoHash;
    const yeter = o.dogrulandi && o.downMbps >= hedef;
    const isaret = dogrulama?.s.infoHash === ih ? '🔎' : o.dogrulandi ? (yeter ? '✓' : '✗') : olu.has(ih) ? '✗' : o.downMbps ? '…' : '⏳';
    const grup = grupAdi(s);
    return el('li', { class: yeter ? 'iyi' : olu.has(ih) ? 'birakildi' : '' },
      `${isaret} ${s.quality || '?'}${s.hdr ? ` ${s.hdr}` : ''} · ${formatSize(s.sizeBytes) || '?'}${grup ? ` · ${grup}` : ''}`
      + `${trAltyazi(s) ? ' · TR altyazı' : ''} — 👤 ${o.peers} · ↓ ${o.downMbps}${o.dogrulandi ? ' (tek başına)' : ''} / ${Math.round(hedef)} Mbps`);
  }));
}
function otoDurdur() {
  clearInterval(otoSayac);
  otoSayac = null;
  $('#oto-bar').hidden = !document.body.classList.contains('oto-mod');
  otoModGoster();
}
function otoDene() {
  otoModGoster();
  if (!otoKutu.checked || otoIptal || otoHata || otoSayac) return;
  if (olusturuluyor) return otoYaz('🤖 Oda açılıyor…');
  if (!tercihKalite && $('#kalite-sor').open) return otoYaz('🤖 Önce tercih ettiğin kaliteyi seç.');
  // Bütün eklentileri beklemeden başla: seçilen kalitede en az 3 aday geldiyse (çoğunlukla Torrentio,
  // 1-2 sn) deneme başlıyor; yavaş eklenti (ThePirateBay+ vb.) 12 sn'ye kadar bekletiyordu. Geç gelen
  // eklentinin kaynakları havuza sonradan giriyor.
  if (!otoAdaylar.length) {
    const beklendi = otoIlkCevap && Date.now() - otoIlkCevap > 12_000;
    const ilk = otoAdayBul().slice(0, OTO_ERKEN);
    const erken = ilk.length === OTO_ERKEN && ilk.every((s) => s.quality === ilk[0].quality);
    if (!loadDone && !beklendi && !erken) return otoYaz(`🤖 Otomatik mod: kaynaklar aranıyor… (${addonsReplied} eklenti cevap verdi)`);
    if (!otoAdayBul().length) {
      if (loadDone) {
        // Hiç torrent yok: listeyi (ve hata mesajını) göster.
        otoHata = true;
        otoModGoster();
        $('#oto-bar').hidden = true;
      }
      return;
    }
  }
  canliOku();
  otoListeYaz();
  const alt = altKalite();
  const havuz = otoHavuz();
  // Alt kaliteye geçiş elle: 30 sn'de yeten çıkmadıysa ya da adaylar bittiyse "1080p'ye geç" düğmesi.
  const yeterliler = otoAdaylar.filter((s) => dogrulanan.has(s.infoHash) && dogrulanan.get(s.infoHash).mbps >= yeterliMbps(s));
  $('#oto-kalite').hidden = !(alt && !yeterliler.length && (Date.now() - otoBaslangic > 30_000 || (!havuz.length && !aktif.size)));
  if (alt) $('#oto-kalite').textContent = `${kaliteAdi(alt)}'ye geç`;
  if (dogrulama) return dogrulamaIlerlet();
  let secilen = null;
  if (yeterliler.length) {
    // Yetenler arasında: dosyada Türkçe altyazı, sonra hız.
    secilen = yeterliler.sort((a, b) => trAltyazi(b) - trAltyazi(a) || dogrulanan.get(b.infoHash).mbps - dogrulanan.get(a.infoHash).mbps)[0];
  } else {
    // Veri vermeyen süresini doldurduysa bırak; yerine sıradaki girsin.
    for (const [ih, a] of aktif) if (!ilkVeri.has(ih) && Date.now() - a.bas > ADAY_SURE_MS) adayBirak(ih);
    // Veri veren varsa en hızlısı tek başına doğrulanır.
    const umutlu = [...aktif.values()].filter((a) => ilkVeri.has(a.s.infoHash)).sort((x, y) => ilkVeri.get(y.s.infoHash) - ilkVeri.get(x.s.infoHash))[0];
    if (umutlu) {
      dogrulamaBaslat(umutlu.s);
      return dogrulamaIlerlet();
    }
    // Boş yuvaları doldur.
    for (const s of havuz) {
      if (aktif.size >= OTO_YUVA) break;
      adayBaslat(s);
    }
    if (aktif.size) {
      const bekleyen = [...aktif.values()].map((a) => Math.max(0, Math.ceil((ADAY_SURE_MS - (Date.now() - a.bas)) / 1000)));
      otoYaz(`🤖 İzlenebilir ${kaliteAdi(otoArananKalite())} kaynak aranıyor… (${otoAdaylar.length}/${otoAdayBul().length} aday denendi, `
        + `${aktif.size} tanesi bağlanıyor, en geç ${Math.max(...bekleyen)} sn${hatMbps ? `; hat ~${Math.round(hatMbps)} Mbps` : ''})`);
      return;
    }
    // Adaylar bitti, hiçbiri yetmedi: tek başına ölçülenlerin en iyisi (o kalitenin en iyisi).
    secilen = enIyiAcik ? otoAdaylar.find((s) => s.infoHash === enIyiAcik) : null;
    if (!secilen) {
      otoYaz(`⚠️ ${kaliteAdi(otoArananKalite())} kaynakların hiçbiri veri vermedi (${otoAdaylar.length} aday denendi). `
        + `${alt ? `${kaliteAdi(alt)}'ye geçebilir ya da ` : ''}listeden seçebilirsin.`);
      return;
    }
  }
  // Seçilen dışında açık kalan adaylar kapanır.
  for (const ih of aktif.keys()) if (ih !== secilen.infoHash) kapat(ih);
  aktif.clear();
  if (enIyiAcik && enIyiAcik !== secilen.infoHash) kapat(enIyiAcik);
  otoSecim = secilen;
  const secOlcum = olcum(secilen);
  let kalan = 3;
  const yaz = () => {
    const s = otoSecim;
    const olc = secOlcum?.peers ? ` · ${secOlcum.peers} kişiye bağlandı${secOlcum.downMbps ? `, ↓ ${secOlcum.downMbps} Mbps` : ''}` : '';
    $('#oto-text').textContent = `⚡ ${s.quality || '?'}${s.hdr ? ` ${s.hdr}` : ''} · ${formatSize(s.sizeBytes)} · ${s.seeders ?? '?'} seed${olc} ile oda ${kalan} sn içinde açılıyor…`;
  };
  yaz();
  $('#oto-bar').hidden = false;
  $('#oto-simdi').hidden = false;
  $('#oto-kalite').hidden = true;
  otoSayac = setInterval(() => {
    kalan -= 1;
    if (kalan > 0) return yaz();
    otoDurdur();
    otoAc();
  }, 1000);
}
function otoAc() {
  const button = [...document.querySelectorAll('#streams button.primary')].find((b) => b.dataset.sid === otoSecim?.streamId)
    || document.createElement('button');
  createRoom(otoSecim, button, { oto: true });
}
$('#oto-simdi').addEventListener('click', () => { otoDurdur(); otoAc(); });
// Elle alt kaliteye geçiş: o kalitenin adayları kapanır, arama yeni kaliteyle baştan.
$('#oto-kalite').addEventListener('click', () => {
  const alt = altKalite();
  if (!alt || otoSayac) return;
  otoKaliteZorla = alt;
  dogrulama = null;
  for (const ih of aktif.keys()) kapat(ih);
  if (enIyiAcik) kapat(enIyiAcik);
  aktif.clear();
  enIyiAcik = null;
  otoAdaylar = [];
  otoBaslangic = 0;
  $('#oto-kalite').hidden = true;
  otoDene();
});
$('#oto-iptal').addEventListener('click', () => { otoIptal = true; otoDurdur(); $('#oto-bar').hidden = true; });
setInterval(otoDene, 1000);
otoDene();

// Bu sayfa açık ve görünürken torrent'ler açık kalıyor; kapanınca/arka plana geçince (sekme
// değişti, pencere küçüldü) sunucu hepsini hemen kapatıyor. Geri gelince görünenler yeniden denetleniyor.
const KEY = document.querySelector('meta[name="panel-key"]').content;
const sayfaBildir = (yol) => fetch(yol, {
  method: 'POST', keepalive: true,
  headers: { 'x-panel-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ type, id }),
}).catch(() => {});
setInterval(() => { if (!document.hidden && !olusturuluyor) sayfaBildir('/api/bakiyor'); }, 8000);
document.addEventListener('visibilitychange', () => {
  if (olusturuluyor) return;
  if (document.hidden) sayfaBildir('/api/sayfa-kapandi');
  else {
    sayfaBildir('/api/bakiyor');
    if (loadDone) gorunenleriDenetle();
  }
});
window.addEventListener('pagehide', () => { if (!olusturuluyor) sayfaBildir('/api/sayfa-kapandi'); });

try {
  if (!type || !id) throw new Error('İçerik bilgisi yok. Bu sayfayı Stremio\'dan aç.');
  render();
  await apiStream(`/api/streams?${new URLSearchParams({ type, id })}`, (line) => {
    if (line.type === 'meta') {
      sureSn = Number(line.meta.sureSn) || null;
      document.title = `${line.meta.name} · Oda aç`;
      $('#title').textContent = line.meta.name;
      sessionStorage.setItem(`ad:${String(id).split(':')[0]}`, line.meta.name.replace(/\s+S\d+E\d+.*$/, '').trim());
      if (line.meta.poster) {
        $('#poster').src = line.meta.poster;
        $('#poster').hidden = false;
      }
    } else if (line.type === 'addon') {
      otoIlkCevap ||= Date.now();
      addonsReplied += 1;
      addonReplied(line);
      render();
    } else if (line.type === 'done') {
      loadDone = true;
      renderErrors(line.errors);
      render();
    }
  });
} catch (err) {
  $('#title').textContent = 'Hata';
  $('#streams').replaceChildren(el('p', { class: 'error', text: err.message }));
}

// Kalite tercihi (Stremio'dan doğrudan gelindiyse burada soruluyor; aramadan gelindiyse orada sorulmuştu). Masaüstü
// uygulamasında açılış ekranında seçildiyse o kullanılıyor (sunucuya da bildiriliyor).
(async () => {
  const sunucuda = (await api('/api/tercih').catch(() => null))?.kalite;
  const uygulamada = window.kabuk?.kalite?.();
  if (sunucuda) return;
  if (uygulamada) {
    tercihKalite = uygulamada;
    otoDene();
    return api('/api/tercih', { method: 'POST', body: { kalite: uygulamada } }).catch(() => {});
  }
  const sor = $('#kalite-sor');
  for (const b of sor.querySelectorAll('button[data-q]')) {
    b.addEventListener('click', async () => {
      await api('/api/tercih', { method: 'POST', body: { kalite: b.dataset.q } }).catch(() => {});
      window.kabuk?.kaliteYaz?.(b.dataset.q);
      sor.close();
      tercihKalite = b.dataset.q;
      render();
      otoDene();
    });
  }
  sor.showModal();
})();
