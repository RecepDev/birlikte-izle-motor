import { el, formatSize } from './ui.js';

export function streamLabel(s) {
  if (!s) return '';
  return [s.quality || '?', formatSize(s.sizeBytes)].filter(Boolean).join(' ');
}

export function renderQuality(listEl, room, { myStreamId, isHost, onPickOwn, onPickHost }) {
  const items = room.streams.map((s) => {
    const isHostStream = s.streamId === room.hostStreamId;
    const isMine = s.streamId === myStreamId;
    const info = [s.addonName, s.title || s.name].filter(Boolean).join(' · ');
    const buttons = [];
    if (!isMine) {
      buttons.push(
        el('button', {
          type: 'button',
          text: isHostStream ? "Host'unkine dön" : 'Ben bunu izleyeyim',
          onclick: () => onPickOwn(isHostStream ? null : s.streamId),
        }),
      );
    }
    if (isHost && !isHostStream) {
      buttons.push(el('button', { type: 'button', text: 'Herkes için seç', onclick: () => onPickHost(s.streamId) }));
    }
    return el(
      'li',
      { class: isMine ? 'current' : '' },
      el('span', { class: 'q', text: s.quality || '?' }),
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
