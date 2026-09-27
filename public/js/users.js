import { el } from './ui.js';

const STATE = {
  ready: ['▶', 'hazır'],
  loading: ['⏳', 'yükleniyor'],
  buffering: ['⏳', 'donuyor'],
  error: ['⚠️', 'video açılamadı'],
  noStremio: ['🚫', 'Stremio açık değil'],
  idle: ['💤', 'bekliyor'],
};
const SOURCE = { local: 'kendi Stremio\'su', relay: '📶 host üzerinden', http: 'doğrudan link', none: '' };

// Video neden açılmadı (kişinin cihazından gelen sebep).
const ERROR_REASON = {
  unsupported: 'cihaz bu biçimi açamıyor', decode: 'çözülemedi', network: 'videoya ulaşılamadı',
  timeout: '60 sn başlamadı, kaynak zayıf', hls: 'uyumlu mod da açamadı', compat: 'uyumlu mod yok',
};

export const DURATION_TOLERANCE_S = 2;

export function durationMismatch(user, hostUser) {
  const a = user?.status?.duration;
  const b = hostUser?.status?.duration;
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > DURATION_TOLERANCE_S;
}

export function renderUsers(listEl, room, meId, { onKick, streamLabel, statsFor = () => null }) {
  const host = room.users.find((u) => u.id === room.hostUserId);
  const iAmHost = room.hostUserId === meId;
  const visible = room.users
    .filter((u) => u.connected || u.id === room.hostUserId)
    .sort((a, b) => Number(b.id === room.hostUserId) - Number(a.id === room.hostUserId));

  listEl.replaceChildren(
    ...visible.map((u) => {
      const [icon, text] = u.connected ? STATE[u.status.state] || STATE.idle : ['🔌', 'bağlantı koptu'];
      const parts = [u.status.state === 'error' && ERROR_REASON[u.status.error] ? `${text} (${ERROR_REASON[u.status.error]})` : text,
        SOURCE[u.status.source], streamLabel(u)];
      // Real torrent numbers when the torrent runs on the host PC, else the browser's estimate.
      const ts = u.connected ? statsFor(u) : null;
      const down = ts ? ts.downMbps : u.status.downMbps;
      if (u.connected && Number.isFinite(down)) parts.push(`↓ ${down >= 10 ? Math.round(down) : down} Mbps`);
      if (ts) parts.push(`🧲 ${ts.peers} peer`);
      if (Number.isFinite(u.status.drift) && u.status.state === 'ready') {
        parts.push(`sapma ${Math.round(u.status.drift * 1000)} ms`);
      }
      return el(
        'li',
        { class: u.connected ? '' : 'away' },
        el('span', { class: 'icon', text: icon }),
        el(
          'div',
          { class: 'who' },
          el(
            'div',
            { class: 'name' },
            u.name,
            u.id === meId ? ' (sen)' : '',
            u.isHost ? el('span', { class: 'badge', text: 'host' }) : null,
            u.id !== room.hostUserId && durationMismatch(u, host)
              ? el('span', { class: 'badge warn', title: 'Farklı sürüm, senkron kayabilir', text: 'süre farklı' })
              : null,
          ),
          el('div', { class: 'meta', text: parts.filter(Boolean).join(' · ') }),
        ),
        iAmHost && u.id !== meId
          ? el('button', { type: 'button', text: 'At', title: 'Odadan çıkar', onclick: () => onKick(u) })
          : null,
      );
    }),
  );
  return visible.filter((u) => u.connected).length;
}
