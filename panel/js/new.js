import { api, el, $, formatSize } from './api.js';

const DEBRID_WARNING = 'Bu bir doğrudan link (ör. Real-Debrid).\n\n'
  + 'Linkte debrid hesabının anahtarı var: arkadaşların senin hesabını kullanır. '
  + 'Real-Debrid farklı IP\'lerden aynı anda kullanımı ban sebebi sayabilir.\n\nYine de bu stream ile oda açılsın mı?';

const params = new URLSearchParams(location.search);
const type = params.get('type');
const id = params.get('id');
let streams = [];

async function createRoom(stream, button) {
  if (stream.kind === 'http' && !confirm(DEBRID_WARNING)) return;
  button.disabled = true;
  button.textContent = 'Oda açılıyor…';
  try {
    const res = await api('/api/rooms', { method: 'POST', body: { type, id, streamId: stream.streamId } });
    location.href = res.roomUrl;
  } catch (err) {
    alert(`Oda açılamadı: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Bununla oda aç';
  }
}

function render() {
  const q = $('#filter').value.trim().toLowerCase();
  const visible = streams.filter((s) => !q || `${s.name} ${s.title} ${s.quality}`.toLowerCase().includes(q));
  const box = $('#streams');
  if (!streams.length) {
    box.replaceChildren(el('p', { class: 'muted', text: "Hiç stream bulunamadı. Panelde Torrentio gibi bir stream addon'u ekli ve açık mı?" }));
    return;
  }
  const groups = new Map();
  for (const s of visible) {
    if (!groups.has(s.addonName)) groups.set(s.addonName, []);
    groups.get(s.addonName).push(s);
  }
  box.replaceChildren(el('ul', { class: 'streams' }, ...[...groups].flatMap(([addon, list]) => [
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
          s.notWebReady ? el('span', { class: 'kind', text: ' · tarayıcıda dönüştürme gerekebilir' }) : null,
          s.videoRisk ? el('span', { class: 'kind risk', text: ` · ⚠️ ${s.videoRisk}: tarayıcıda görüntü gelmeyebilir (uyumlu mod devreye girer)` }) : null),
        button,
      );
    }),
  ])));
}

$('#filter').addEventListener('input', render);

try {
  if (!type || !id) throw new Error('İçerik bilgisi yok. Bu sayfayı Stremio\'dan aç.');
  const data = await api(`/api/streams?${new URLSearchParams({ type, id })}`);
  document.title = `${data.meta.name} · Oda aç`;
  $('#title').textContent = data.meta.name;
  if (data.meta.poster) {
    $('#poster').src = data.meta.poster;
    $('#poster').hidden = false;
  }
  if (data.errors.length) {
    $('#errors').replaceChildren(
      `Cevap vermeyen addon'lar: ${data.errors.map((e) => `${e.addonName} (${e.message})`).join(', ')} `,
      el('button', { type: 'button', text: '↻ Tekrar dene', onclick: () => location.reload() }),
    );
    $('#errors').hidden = false;
  }
  streams = data.streams;
  render();
} catch (err) {
  $('#title').textContent = 'Hata';
  $('#streams').replaceChildren(el('p', { class: 'error', text: err.message }));
}
