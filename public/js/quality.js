import { el, formatSize } from './ui.js';

export function streamLabel(s) {
  if (!s) return '';
  return [s.quality || '?', formatSize(s.sizeBytes)].filter(Boolean).join(' ');
}

export const formatMbps = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toString();

// needFor(stream) -> Mbps the file needs (or null); have -> measured Mbps (or null).
export function renderQuality(listEl, room, { myStreamId, isHost, onPickOwn, onPickHost, needFor = () => null, have = null }) {
  const items = room.streams.map((s) => {
    const isHostStream = s.streamId === room.hostStreamId;
    const isMine = s.streamId === myStreamId;
    const info = [s.addonName, s.title || s.name].filter(Boolean).join(' · ');
    const need = needFor(s);
    const heavy = need !== null && have !== null && need > have * 0.95;
    const buttons = [];
    if (!isMine) {
      const label = isHostStream ? "Host'unkine dön" : 'Ben bunu izleyeyim';
      buttons.push(
        el('button', {
          type: 'button',
          class: 'icon-btn',
          text: isHostStream ? '↩️' : '👁️',
          title: label,
          'aria-label': label,
          onclick: () => onPickOwn(isHostStream ? null : s.streamId),
        }),
      );
    }
    if (isHost && !isHostStream) {
      buttons.push(el('button', {
        type: 'button',
        class: 'icon-btn',
        text: '👥',
        title: 'Herkes için seç',
        'aria-label': 'Herkes için seç',
        onclick: () => onPickHost(s.streamId),
      }));
    }
    return el(
      'li',
      { class: isMine ? 'current' : '' },
      el('span', { class: 'q' }, s.quality || '?',
        need !== null ? el('div', { class: `need${heavy ? ' heavy' : ''}`, text: `~${formatMbps(need)} Mbps${heavy ? ' ⚠️' : ''}`, title: heavy ? 'İndirme hızın bu dosyaya yetmeyebilir' : 'Akıcı izlemek için gereken indirme hızı' }) : null),
      el('div', { class: 'info', text: `${formatSize(s.sizeBytes)} ${info}`.trim() }),
      el(
        'div',
        { class: 'btns' },
        isHostStream ? el('span', { class: 'badge', text: 'host' }) : null,
        isMine ? el('span', { class: 'badge', text: 'izliyorsun' }) : null,
        ...buttons,
      ),
    );
  });
  listEl.replaceChildren(...items);
}
