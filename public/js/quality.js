import { el, formatSize } from './ui.js';

export function streamLabel(s) {
  if (!s) return '';
  return [s.quality || '?', formatSize(s.sizeBytes)].filter(Boolean).join(' ');
}

export const formatMbps = (v) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toString();

// needFor(stream) -> Mbps the file needs (or null).
// checkStatusFor(stream) -> { checking, result: { peers, downMbps, alive } | null } | null
export function renderQuality(listEl, room, {
  myStreamId, isHost, onPickOwn, onPickHost, needFor = () => null, pictureFor = () => null,
  checkStatusFor = () => null, onCheckStream = () => {},
}) {
  const items = room.streams.map((s) => {
    const isHostStream = s.streamId === room.hostStreamId;
    const isMine = s.streamId === myStreamId;
    // Seeders and size are shown under the quality label; keep just the name here.
    const title = String(s.title || s.name).split('\n')[0];
    const info = [s.addonName, title].filter(Boolean).join(' · ');
    const need = needFor(s);
    const check = s.kind === 'torrent' ? checkStatusFor(s) : null;
    const buttons = [];
    if (isHost && s.kind === 'torrent') {
      buttons.push(el('button', {
        type: 'button',
        class: 'icon-btn',
        text: check?.checking ? '⏳' : '🔍',
        title: check?.checking ? 'Kontrol ediliyor…' : 'Bu torrenti test et (gerçekten veri geliyor mu)',
        'aria-label': 'Torrenti test et',
        disabled: check?.checking ? true : null,
        onclick: () => onCheckStream(s.streamId),
      }));
    }
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
        need !== null ? el('div', { class: 'need', text: `~${formatMbps(need)} Mbps`, title: 'Akıcı izlemek için gereken indirme hızı' }) : null,
        Number.isFinite(s.seeders) ? el('div', { class: 'need', text: `👤 ${s.seeders}`, title: 'Torrent kaynak (seed) sayısı' }) : null,
        s.sizeBytes ? el('div', { class: 'need', text: `💾 ${formatSize(s.sizeBytes)}`, title: 'Dosya boyutu' }) : null,
        check?.result
          ? el('div', {
            class: `need ${check.result.alive ? 'okline' : 'heavy'}`,
            text: check.result.alive ? `✅ ${formatMbps(check.result.downMbps)} Mbps · ${check.result.peers} peer` : '⚠️ veri gelmiyor',
            title: check.result.alive
              ? 'Test sırasında gerçekten veri indi.'
              : "Peer'lar bağlansa da birkaç saniye içinde hiç veri gelmedi — muhtemelen ölü kaynak.",
          })
          : null),
      el('div', { class: 'info' },
        (() => {
          const items = pictureFor(s) || [];
          if (!items.length) return null;
          return el('div', { class: 'pics' }, ...items.flatMap(({ icon, text }) => [
            el('span', { class: 'ic', title: text, 'aria-label': text }, icon),
            el('span', { class: 'info-i', tabindex: '0', title: text }, 'ⓘ'),
          ]));
        })(),
        el('div', { class: 'title', title: String(s.title || s.name) }, info)),
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
