import { api, apiStream, el, $, formatSize } from './api.js';
import { browserCodecs } from './codecs.js';
import { otomatikSec } from './kaynak-sec.js';

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
  otoIptal = true; // elle ya da otomatik: bir kez
  if (stream.kind === 'http' && !confirm(DEBRID_WARNING)) return;
  button.disabled = true;
  olusturuluyor = true;
  button.textContent = 'Oda açılıyor…';
  try {
    const res = await api('/api/rooms', { method: 'POST', body: { type, id, streamId: stream.streamId } });
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
const otoKutu = $('#oto-kaynak');
otoKutu.checked = localStorage.getItem('otoKaynak') !== '0';
otoKutu.addEventListener('change', () => {
  localStorage.setItem('otoKaynak', otoKutu.checked ? '1' : '0');
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
const OTO_IYI_MBPS = 15;
const OTO_OLCUM_MS = 20_000;
const otoPuan = (s) => (Number(s.seeders) || 0) * (s.pack ? 0.35 : 1);
function otoAdayBul() {
  const torrents = streams.filter((s) => s.kind === 'torrent');
  const secilen = otomatikSec(streams, tercihKalite);
  if (!secilen) return [];
  // Seçilen kalitedeki en iyi 4; azsa başka kalitelerden sırayla tamamla.
  const ayni = torrents.filter((s) => s.quality === secilen.quality).sort((a, b) => otoPuan(b) - otoPuan(a));
  const diger = torrents.filter((s) => s.quality !== secilen.quality && (Number(s.seeders) || 0) >= 3)
    .sort((a, b) => otoPuan(b) - otoPuan(a));
  return [...ayni, ...diger].slice(0, 4);
}
const olcum = (s) => sonuclar.get(s.infoHash) || enIyi.get(s.infoHash) || null;
function otoDurdur() {
  clearInterval(otoSayac);
  otoSayac = null;
  $('#oto-bar').hidden = true;
}
function otoDene() {
  if (!otoKutu.checked || otoIptal || olusturuluyor || otoSayac) return;
  if (!tercihKalite && $('#kalite-sor').open) return; // önce kalite sorusu
  const beklendi = otoIlkCevap && Date.now() - otoIlkCevap > 12_000;
  if (!loadDone && !beklendi) return;
  if (!otoAdaylar.length) {
    otoAdaylar = otoAdayBul();
    if (!otoAdaylar.length) return;
    otoOlcumBasi = Date.now();
    const olcumsuz = otoAdaylar.filter((s) => !durum[s.infoHash] && !sonuclar.has(s.infoHash)).map((s) => s.streamId);
    if (olcumsuz.length) api('/api/torrent-denetle', { method: 'POST', body: { type, id, streamIds: olcumsuz } }).catch(() => {});
  }
  // Ölçüm: biri çok hızlıysa hemen, yoksa hepsi bitince ya da 20 sn dolunca karar.
  const sonuc = otoAdaylar.map((s) => ({ s, o: olcum(s) }));
  const hizli = sonuc.some((x) => (x.o?.downMbps || 0) >= OTO_IYI_MBPS);
  const bitti = otoAdaylar.every((s) => sonuclar.has(s.infoHash));
  if (!hizli && !bitti && Date.now() - otoOlcumBasi < OTO_OLCUM_MS) {
    const olculen = sonuc.filter((x) => x.o?.peers).length;
    $('#oto-text').textContent = `⚡ En iyi kaynak ölçülüyor… (${otoAdaylar.length} aday, ${olculen} tanesi bağlandı, `
      + `${Math.ceil((OTO_OLCUM_MS - (Date.now() - otoOlcumBasi)) / 1000)} sn)`;
    $('#oto-bar').hidden = false;
    return;
  }
  const sirali = sonuc.sort((a, b) => (b.o?.downMbps || 0) - (a.o?.downMbps || 0)
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
$('#oto-iptal').addEventListener('click', () => { otoIptal = true; otoDurdur(); });
setInterval(otoDene, 1000);

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
      document.title = `${line.meta.name} · Oda aç`;
      $('#title').textContent = line.meta.name;
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
