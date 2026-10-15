import { el } from './ui.js';

const STATE = {
  ready: ['▶', 'hazır'],
  loading: ['⏳', 'yükleniyor'],
  buffering: ['⏳', 'donuyor'],
  error: ['⚠️', 'video açılamadı'],
  noStremio: ['🚫', 'Video motoru kapalı'],
  idle: ['💤', 'bekliyor'],
};
const SOURCE = { local: 'kendi motoru', relay: '📶 host üzerinden', http: 'doğrudan link', none: '' };

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

export function renderUsers(listEl, room, meId, { onKick, onDiag = null, streamLabel, statsFor = () => null, relayFor = () => null }) {
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
      // Kişinin kendi ölçtüğü hız önce (host'un torrent hızı herkes için aynı sayıyı gösteriyordu);
      // relay'de host'tan ona giden hız.
      const relayMbps = relayFor(u);
      const down = u.status.source === 'relay' && Number.isFinite(relayMbps) ? relayMbps
        : Number.isFinite(u.status.downMbps) ? u.status.downMbps : ts?.downMbps;
      if (u.connected && Number.isFinite(down)) parts.push(`↓ ${down >= 10 ? Math.round(down) : down} Mbps`);
      if (ts) parts.push(`🧲 ${ts.peers} peer`);
      if (Number.isFinite(u.status.drift) && u.status.state === 'ready') {
        parts.push(`sapma ${Math.round(u.status.drift * 1000)} ms`);
      }
      // Canlı yayını izleyen: kendi oynatıcısı boşta; yayından gelen görüntünün verileri gösteriliyor.
      const yy = u.connected && u.status.yayin;
      const satirSimge = yy ? '📡' : icon;
      const satirBilgi = yy
        ? ['yayını izliyor', yy.yukseklik ? `${yy.yukseklik}p` : null, yy.fps ? `${yy.fps} fps` : null,
          Number.isFinite(yy.mbps) ? `↓ ${yy.mbps} Mbps` : null, yy.kayip ? `${yy.kayip} paket kaybı` : null].filter(Boolean).join(' · ')
        : parts.filter(Boolean).join(' · ');
      return el(
        'li',
        { class: u.connected ? '' : 'away' },
        el('span', { class: 'icon', text: satirSimge }),
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
          el('div', { class: 'meta', text: satirBilgi }),
        ),
        iAmHost && onDiag
          ? el('button', { type: 'button', class: 'tani-btn', text: 'Kayıt', title: 'Bu kişinin oynatıcı kaydı (takılma, sarma, sapma, hız)', onclick: () => onDiag(u) })
          : null,
        iAmHost && u.id !== meId
          ? el('button', { type: 'button', text: 'At', title: 'Odadan çıkar', onclick: () => onKick(u) })
          : null,
      );
    }),
  );
  return visible.filter((u) => u.connected).length;
}
