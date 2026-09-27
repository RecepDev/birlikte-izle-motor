import { api, apiStream, el, $, formatSize } from './api.js';
import { browserCodecs } from './codecs.js';

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

async function createRoom(stream, button) {
  if (stream.kind === 'http' && !confirm(DEBRID_WARNING)) return;
  button.disabled = true;
  button.textContent = 'Oda açılıyor…';
  try {
    const res = await api('/api/rooms', { method: 'POST', body: { type, id, streamId: stream.streamId } });
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
    alert(`Oda açılamadı: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Bununla oda aç';
  }
}

function render() {
  const q = $('#filter').value.trim().toLowerCase();
  renderQualityChips();
  const visible = streams.filter((s) => (!q || `${s.name} ${s.title} ${s.quality}`.toLowerCase().includes(q))
    && (!qualityFilter || qualityOf(s) === qualityFilter));
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
          s.hdr ? el('span', { class: 'kind risk', text: ` · 🌗 ${s.hdr}: HDR olmayan ekranda karanlık görünebilir` }) : null,
          s.embeddedSubs ? el('span', { class: 'kind', text: ` · 💬 gömülü altyazı${s.embeddedSubs.langs.length ? ` (${s.embeddedSubs.langs.join(', ')})` : ''}` }) : null),
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

$('#filter').addEventListener('input', render);
$('#refresh-addons').addEventListener('click', refreshAll);

const masaustuKutu = $('#masaustu');
// Zaten masaüstü kabuğundaysak seçenek anlamsız: oda aynı pencerede açılıyor.
const kabuktayiz = /Electron/.test(navigator.userAgent);
if (kabuktayiz) masaustuKutu.closest('.row').hidden = true;
masaustuKutu.checked = !kabuktayiz && localStorage.getItem('masaustuAc') === '1';
masaustuKutu.addEventListener('change', () => localStorage.setItem('masaustuAc', masaustuKutu.checked ? '1' : '0'));

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
