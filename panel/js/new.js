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
      // Otomatik seçimin adayları kapatılmasın: seçilen hemen oda açılınca kullanılacak.
      if (otoAdaylar.some((s) => s.infoHash === h) && sonuclar.get(h)?.peers) continue;
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
let otoIptal = false;
let otoSayac = null;
let otoIlkCevap = null;
let otoSecim = null;
// Seed sayısı addon'un eski bilgisi: en umut verici 4 aday Stremio'da gerçekten açılıp
// ölçülüyor (bağlanılan kişi, gerçek hız); en hızlı olan seçiliyor.
let otoAdaylar = [];
let otoOlcumBasi = 0;
// "Yeterince hızlı" kaynağa göre: videonun ihtiyacı (boyut / süre) x pay; süre bilinmiyorsa sabit 15 Mbps.
// Sabit 15, 2 GB'lık 1080p bölüm için gereksiz bekletiyor (5 Mbps yetiyor), 20 GB'lık 4K için azdı.
// Pay arama uzadıkça iniyor (30 sn'ye kadar 1.5, 60 sn'ye kadar 1.25, sonra 1.1) ama ihtiyacın altına
// hiç inmiyor: izlenebilir olmayan kaynak "yeterli" sayılmıyor.
const OTO_IYI_MBPS = 15;
let sureSn = null; // içeriğin süresi (Cinemeta), meta satırıyla geliyor
let otoBaslangic = 0; // ilk dalganın başladığı an
const ihtiyacMbps = (s) => (sureSn && s.sizeBytes ? (s.sizeBytes * 8) / sureSn / 1e6 : null);
function payKatsayisi() {
  const sn = otoBaslangic ? (Date.now() - otoBaslangic) / 1000 : 0;
  return sn < 30 ? 1.5 : sn < 60 ? 1.25 : 1.1;
}
function yeterliMbps(s) {
  const ihtiyac = ihtiyacMbps(s);
  return ihtiyac ? Math.max(4, ihtiyac * payKatsayisi()) : OTO_IYI_MBPS;
}
// Dalga en çok bu kadar sürüyor; adaylarının hepsi sonuçlanınca (bağlanan 12 sn'de ölçülmüş sayılıyor,
// bağlanamayan 25 sn'de "kimse yok") hemen sonrakine geçiliyor. 12 sn'de kesilince 6'sı birden açıkken
// geç bağlanan adaylar (aynı anda çok torrent bağlanmayı yavaşlatıyor) şans bulamadan eleniyordu.
const OTO_OLCUM_MS = 25_000;
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
function otoAdayBul() {
  const torrents = streams.filter((s) => s.kind === 'torrent');
  const kalite = otoArananKalite();
  if (!kalite) return [];
  // Sınır yok: videoya yetecek hızda kaynak bulunana kadar 6'şarlı dalgalarla ölçülüyor. Odada daha önce
  // bırakılan kaynaklar en sonda.
  const hepsi = hafizaOnce(torrents.filter((s) => s.quality === kalite).sort((a, b) => otoPuan(b) - otoPuan(a)), kaynakHafiza);
  const kotu = new Set(kaynakOzet.kotu || []);
  return [...hepsi.filter((s) => !kotu.has(s.infoHash)), ...hepsi.filter((s) => kotu.has(s.infoHash))];
}
// Dalga 6 (kullanıcı istedi, 2026-10-07; önce 4). Ölçüm başlamak için 4 aday yetiyor (OTO_ERKEN).
const OTO_DALGA = 6;
const OTO_ERKEN = 4;
let otoTumAdaylar = [];
// Dizide önceki bölümlerde iyi indiren kaynağın grubu: önce onlar ölçülüyor.
let kaynakHafiza = null;
if (type === 'series') api(`/api/kaynak-hafiza?${new URLSearchParams({ id })}`).then((h) => { kaynakHafiza = h; }).catch(() => {});
// Henüz ölçülmeyen adaylar. Havuz her dalgada yeniden hesaplanıyor: ölçüm yavaş eklentiyi beklemeden
// başladığı için sonradan gelen eklentilerin kaynakları da sıraya giriyor.
function otoHavuz() {
  const olculen = new Set(otoAdaylar.map((s) => s.infoHash));
  return otoAdayBul().filter((s) => !olculen.has(s.infoHash));
}
// Yeni dalga başlarken önceki adayların en iyisi dışındakiler kapatılıyor: aynı anda açık torrent
// azalınca yenileri daha çabuk bağlanıyor (ölçüm: 8 torrent birden açıkken film bilgisi 6 kat geç geldi).
// Ölçülen değerleri listede kalıyor; en iyisi seçilme ihtimaline karşı açık.
const otoKapatilan = new Set();
function oncekileriKapat() {
  if (!otoAdaylar.length) return;
  const puan = (s) => [olcum(s)?.downMbps || 0, olcum(s)?.peers || 0];
  const enIyisi = [...otoAdaylar].sort((a, b) => puan(b)[0] - puan(a)[0] || puan(b)[1] - puan(a)[1])[0];
  for (const s of otoAdaylar) {
    if (s === enIyisi || otoKapatilan.has(s.infoHash)) continue;
    otoKapatilan.add(s.infoHash);
    if (!sonuclar.has(s.infoHash)) sonuclar.set(s.infoHash, enIyi.get(s.infoHash) || { peers: 0, downMbps: 0 });
    api('/api/torrent-kapat', { method: 'POST', body: { infoHash: s.infoHash } }).catch(() => {});
  }
}
function otoDalgaBaslat() {
  oncekileriKapat();
  const havuz = otoHavuz();
  const yeni = havuz.slice(0, OTO_DALGA);
  otoAdaylar = [...otoAdaylar, ...yeni];
  otoTumAdaylar = [...otoAdaylar, ...havuz.slice(OTO_DALGA)];
  otoOlcumBasi = Date.now();
  otoBaslangic ||= otoOlcumBasi;
  // Önceden açılmış (ısıtılmış) olanlar da ölçüme gidiyor: TorrServer'da hız ancak okurken görünüyor,
  // ısıtma yalnız 1 MB okuyor.
  const olcumsuz = yeni.filter((s) => !sonuclar.has(s.infoHash)).map((s) => s.streamId);
  if (olcumsuz.length) api('/api/torrent-denetle', { method: 'POST', body: { type, id, streamIds: olcumsuz } }).catch(() => {});
}
const olcum = (s) => sonuclar.get(s.infoHash) || enIyi.get(s.infoHash) || null;
// Ölçülen adaylar canlı: kalite, boyut, grup, kişi, hız / çıta. ✓ yetiyor, ✗ bırakıldı, ⏳ bağlanıyor.
function otoListeYaz(sonuc) {
  const kutu = $('#oto-liste');
  if (!kutu) return;
  const satirlar = [...sonuc].sort((a, b) => (b.o?.downMbps || 0) - (a.o?.downMbps || 0)).slice(0, 8);
  kutu.hidden = !satirlar.length;
  kutu.replaceChildren(...satirlar.map(({ s, o }) => {
    const hedef = yeterliMbps(s);
    const hiz = o?.downMbps || 0;
    const isaret = hiz >= hedef ? '✓' : otoKapatilan.has(s.infoHash) ? '✗' : o?.peers ? '…' : '⏳';
    const grup = grupAdi(s);
    return el('li', { class: hiz >= hedef ? 'iyi' : otoKapatilan.has(s.infoHash) ? 'birakildi' : '' },
      `${isaret} ${s.quality || '?'}${s.hdr ? ` ${s.hdr}` : ''} · ${formatSize(s.sizeBytes) || '?'}${grup ? ` · ${grup}` : ''}`
      + `${trAltyazi(s) ? ' · TR altyazı' : ''} — 👤 ${o?.peers || 0} · ↓ ${hiz} / ${Math.round(hedef)} Mbps`);
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
  // Bütün eklentileri beklemeden başla: seçilen kalitede en az 4 aday geldiyse (çoğunlukla Torrentio,
  // 1-2 sn) ölçüm başlıyor; yavaş eklenti (ThePirateBay+ vb.) 12 sn'ye kadar bekletiyordu.
  const beklendi = otoIlkCevap && Date.now() - otoIlkCevap > 12_000;
  const ilkAdaylar = otoAdaylar.length ? [] : otoAdayBul().slice(0, OTO_ERKEN);
  const erken = ilkAdaylar.length === OTO_ERKEN && ilkAdaylar.every((s) => s.quality === ilkAdaylar[0].quality);
  if (!loadDone && !beklendi && !erken && !otoAdaylar.length) {
    return otoYaz(`🤖 Otomatik mod: kaynaklar aranıyor… (${addonsReplied} eklenti cevap verdi)`);
  }
  if (!otoAdaylar.length) {
    otoTumAdaylar = otoAdayBul();
    if (!otoTumAdaylar.length) {
      // Hiç torrent yok: listeyi (ve hata mesajını) göster.
      if (loadDone) {
        otoHata = true;
        otoModGoster();
        $('#oto-bar').hidden = true;
      }
      return;
    }
    otoDalgaBaslat();
  }
  // Ölçüm: biri videoya yetecek kadar hızlıysa hemen; yoksa dalga bitince sıradakiler. Yeten bulunana ya
  // da adaylar bitene kadar sürüyor (kullanıcı istedi: "yeter ki izlenebilir kaynağı bulsun").
  const sonuc = otoAdaylar.map((s) => ({ s, o: olcum(s) }));
  otoListeYaz(sonuc);
  const yeterliler = sonuc.filter((x) => (x.o?.downMbps || 0) >= yeterliMbps(x.s));
  const hizli = yeterliler.length > 0;
  const bitti = otoAdaylar.every((s) => sonuclar.has(s.infoHash));
  const kalanVar = otoHavuz().length > 0;
  // Alt kaliteye geçiş elle: 30 sn'de yeten çıkmadıysa ya da adaylar bittiyse "1080p'ye geç" düğmesi.
  const alt = altKalite();
  $('#oto-kalite').hidden = !(alt && !hizli && (Date.now() - otoBaslangic > 30_000 || !kalanVar));
  if (alt) $('#oto-kalite').textContent = `${kaliteAdi(alt)}'ye geç`;
  // Bu dalga bitti, hızlı kaynak yok ve sırada aday var: sonraki 6'yı ölç.
  if (!hizli && (bitti || Date.now() - otoOlcumBasi >= OTO_OLCUM_MS) && kalanVar) {
    otoDalgaBaslat();
    return;
  }
  if (!hizli && !bitti && Date.now() - otoOlcumBasi < OTO_OLCUM_MS) {
    const olculen = sonuc.filter((x) => x.o?.peers).length;
    otoYaz(`🤖 İzlenebilir ${kaliteAdi(otoArananKalite())} kaynak aranıyor… (${otoAdaylar.length}/${otoTumAdaylar.length} aday, `
      + `${olculen} tanesi bağlandı, çıta videonun ihtiyacının ${payKatsayisi()} katı, `
      + `${Math.ceil((OTO_OLCUM_MS - (Date.now() - otoOlcumBasi)) / 1000)} sn)`);
    return;
  }
  // Adaylar bitti ve hiçbiri veri vermedi: oda açılmıyor (0 Mbps'lik kaynak izlenemez). Kalite elle.
  if (!hizli && !sonuc.some((x) => (x.o?.downMbps || 0) >= 0.5)) {
    otoYaz(`⚠️ ${kaliteAdi(otoArananKalite())} kaynakların hiçbiri veri vermedi (${otoAdaylar.length} aday denendi). `
      + `${alt ? `${kaliteAdi(alt)}'ye geçebilir ya da ` : ''}listeden seçebilirsin.`);
    return;
  }
  const ilkKalite = otoAdaylar[0]?.quality;
  const oran = (x) => (x.o?.downMbps || 0) / (ihtiyacMbps(x.s) || OTO_IYI_MBPS / 1.5);
  const sirali = hizli
    // Yetenler arasında: tercih edilen kalite, sonra dosyada Türkçe altyazı, sonra hız.
    ? yeterliler.sort((a, b) => (b.s.quality === ilkKalite) - (a.s.quality === ilkKalite)
      || trAltyazi(b.s) - trAltyazi(a.s) || (b.o?.downMbps || 0) - (a.o?.downMbps || 0))
    // Hiçbiri yetmedi, aynı kalitedeki adaylar bitti: hızın ihtiyaca oranı en iyi olan (o kalitenin en iyisi).
    // Kalitesi bilinmeyenler (örnek/bozuk dosya olabiliyor: 502 MB "?" seçilmişti) en sonda.
    : sonuc.sort((a, b) => Boolean(b.s.quality) - Boolean(a.s.quality) || oran(b) - oran(a)
      || (b.o?.peers || 0) - (a.o?.peers || 0) || otoPuan(b.s) - otoPuan(a.s));
  otoSecim = sirali[0].s;
  const secOlcum = sirali[0].o;
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
  for (const s of otoAdaylar) {
    if (otoKapatilan.has(s.infoHash)) continue;
    otoKapatilan.add(s.infoHash);
    api('/api/torrent-kapat', { method: 'POST', body: { infoHash: s.infoHash } }).catch(() => {});
  }
  otoAdaylar = [];
  otoTumAdaylar = [];
  otoBaslangic = 0;
  otoOlcumBasi = 0;
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
