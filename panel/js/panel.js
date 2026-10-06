import { api, el, $, copy, formatSize } from './api.js';

const STATE_TEXT = {
  ready: '▶ hazır', loading: '⏳ yükleniyor', buffering: '⏳ donuyor', error: '⚠️ hata',
  noStremio: '🚫 Stremio yok', idle: '💤 bekliyor',
};
const TUNNEL_TEXT = {
  up: ['ok', 'hazır'], starting: ['warn', 'başlatılıyor…'], down: ['bad', 'koptu, yeniden deneniyor'],
  missing: ['bad', 'cloudflared kurulu değil'], stopped: ['bad', 'durduruldu'],
};

let config = null;
let status = null;

// ---- status ------------------------------------------------------------------

async function refreshStatus() {
  try {
    status = await api('/api/status');
  } catch {
    $('#st-stremio').textContent = 'panel sunucuya ulaşamıyor';
    return;
  }
  $('#st-stremio-dot').className = `dot ${status.stremio ? 'ok' : 'warn'}`;
  const motor = status.motor;
  if (motor?.kullanilan === 'torrserver') {
    $('#st-motor-ad').textContent = 'Torrent motoru';
    $('#st-stremio').textContent = status.stremio ? 'TorrServer · açık (Stremio gerekmiyor)' : 'TorrServer kapalı';
  } else if (motor?.istenen === 'torrserver') {
    // Kopya TorrServer'la açılmak istedi ama 11470 doluydu (Stremio açık): Stremio'yla çalışıyor.
    $('#st-motor-ad').textContent = 'Stremio';
    $('#st-stremio-dot').className = 'dot warn';
    $('#st-stremio').textContent = "açık. TorrServer yerine Stremio kullanılıyor: Stremio'yu kapatıp sunucuyu yeniden başlat";
  } else {
    $('#st-motor-ad').textContent = 'Stremio';
    $('#st-stremio').textContent = status.stremio ? 'açık' : 'kapalı (senin videon için Stremio açık olmalı)';
  }

  const [cls, text] = TUNNEL_TEXT[status.tunnel.state] || ['', status.tunnel.state];
  $('#st-tunnel-dot').className = `dot ${cls}`;
  $('#st-tunnel').textContent = text;
  $('#tunnel-url').textContent = status.tunnel.url || '—';
  $('#tunnel-copy').hidden = !status.tunnel.url;
  $('#cf-install').hidden = status.tunnel.state !== 'missing';
  $('#tunnel-restart').hidden = status.tunnel.state === 'missing';

  $('#addon-url').textContent = status.addonUrl;
  $('#addon-install').href = status.addonUrl.replace(/^https?:\/\//, 'stremio://');
}

$('#tunnel-copy').addEventListener('click', (e) => copy(status.tunnel.url, e.target));
$('#addon-copy').addEventListener('click', (e) => copy(status.addonUrl, e.target));
$('#tunnel-restart').addEventListener('click', async () => {
  await api('/api/tunnel/restart', { method: 'POST' });
  refreshStatus();
});
$('#cf-install').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Kuruluyor… (log\'u izle)';
  await api('/api/cloudflared/install', { method: 'POST' }).catch((err) => alert(err.message));
});
$('#shutdown').addEventListener('click', async () => {
  const rooms = await api('/api/rooms').catch(() => []);
  const warn = rooms.length ? `\n${rooms.length} aktif oda kapanacak.` : '';
  if (!confirm(`Birlikte İzle sunucusu kapatılsın mı?${warn}`)) return;
  await api('/api/shutdown', { method: 'POST' }).catch(() => {});
  // Panel penceresini sunucu kapatıyor; normal tarayıcı sekmesindeyse de kapanmayı dene.
  window.close();
  document.body.replaceChildren(el('main', { class: 'narrow' }, el('section', { class: 'card' },
    el('h2', { text: 'Sunucu kapatıldı' }),
    el('p', { class: 'muted', text: 'Bu pencereyi kapatabilirsin. Tekrar açmak için masaüstündeki "Birlikte İzle" kısayolunu kullan.' }))));
});

// ---- rooms -----------------------------------------------------------------------

function roomLink(room) {
  return status?.tunnel.url ? `${status.tunnel.url}/room/${room.id}` : null;
}

// Real torrent stats exist for torrents on this PC (host, relay viewers); others report an estimate.
function downloadText(room, u) {
  if (!u.connected) return '';
  const onThisPc = u.status.source === 'relay' || (u.isHost && u.status.source === 'local');
  const ts = onThisPc ? room.torrentStats?.[u.ownStreamId || room.hostStreamId] : null;
  const down = ts ? ts.downMbps : u.status.downMbps;
  return [
    Number.isFinite(down) ? `↓ ${down} Mbps` : '',
    ts ? `🧲 ${ts.peers} peer` : '',
    Number.isFinite(u.status.ahead) ? `${u.status.ahead} sn` : '',
  ].filter(Boolean).join(' · ');
}

// Bu bilgisayardaki masaüstü uygulamasını açılış ekranıyla başlatır (sunucu açıyor).
async function uygulamayiAc(e) {
  const b = e.target;
  b.disabled = true;
  const res = await api('/api/masaustu-ac', { method: 'POST' }).catch((err) => ({ error: err.message }));
  b.disabled = false;
  if (res.error) alert(res.error === 'yok' ? 'Birlikte İzle uygulaması bulunamadı. Bir kez masaüstündeki kısayoldan aç, sonra tekrar dene.' : res.error);
}

function renderRoom(room) {
  const relayByUser = new Map((room.relay?.users || []).map((u) => [u.userId, u]));
  const link = roomLink(room);
  const rows = room.users
    .filter((u) => u.connected || u.isHost)
    .map((u) => el(
      'tr',
      {},
      el('td', {}, u.name, u.isHost ? ' 👑' : ''),
      el('td', { text: u.connected ? STATE_TEXT[u.status.state] || u.status.state : '🔌 koptu' }),
      el('td', { text: { local: 'kendi Stremio', relay: '📶 relay', http: 'link', none: '—' }[u.status.source] || '' }),
      el('td', { text: u.status.quality || '' }),
      el('td', { text: downloadText(room, u) }),
      el('td', { text: Number.isFinite(u.status.drift) ? `${Math.round(u.status.drift * 1000)} ms` : '' }),
      el('td', { text: relayByUser.has(u.id) ? `${relayByUser.get(u.id).mbps} Mbps` : '' }),
      el('td', {}, u.isHost ? null : el('button', {
        type: 'button',
        text: 'At',
        onclick: async () => {
          if (!confirm(`${u.name} odadan çıkarılsın mı?`)) return;
          await api(`/api/rooms/${room.id}/kick`, { method: 'POST', body: { userId: u.id } }).catch((err) => alert(err.message));
          refreshRooms();
        },
      })),
    ));

  return el(
    'div',
    { class: 'room' },
    el(
      'div',
      { class: 'room-head' },
      room.meta?.poster ? el('img', { src: room.meta.poster, alt: '' }) : null,
      el('div', { class: 't' },
        el('b', { text: room.meta?.name || room.contentId }),
        el('div', { class: 'muted small', text: `Oda ${room.id} · ${room.playback.paused ? 'duraklatıldı' : 'oynuyor'} · ${room.settings.waitMode === 'wait' ? 'herkes bekler' : 'beklemeden devam'}${room.relay?.totalMbps ? ` · relay ${room.relay.totalMbps} Mbps` : ''}` })),
      // Odaya bu bilgisayardaki Birlikte İzle uygulamasıyla (host olarak) gir.
      el('button', {
        type: 'button',
        text: '🖥️ Uygulamada gir',
        onclick: async (e) => {
          const b = e.target;
          b.disabled = true;
          const res = await api(`/api/rooms/${room.id}/masaustu`, { method: 'POST' }).catch((err) => ({ error: err.message }));
          b.disabled = false;
          if (res.error) alert(res.error === 'yok' ? 'Birlikte İzle uygulaması bulunamadı. Bir kez masaüstündeki kısayoldan aç, sonra tekrar dene.' : res.error);
        },
      }),
      link ? el('button', { type: 'button', text: '🔗 Linki kopyala', onclick: (e) => copy(link, e.target) }) : el('span', { class: 'muted small', text: 'tünel hazır değil' }),
      el('button', {
        type: 'button',
        class: 'danger',
        text: 'Odayı kapat',
        onclick: async () => {
          if (!confirm('Oda herkes için kapatılsın mı?')) return;
          await api(`/api/rooms/${room.id}/close`, { method: 'POST' }).catch(() => {});
          refreshRooms();
        },
      }),
    ),
    el('div', { class: 'table-wrap' }, el('table', {},
      el('tr', {}, ...['Kişi', 'Durum', 'Kaynak', 'Kalite', 'İndirme', 'Sapma', 'Relay', ''].map((h) => el('th', { text: h }))),
      ...rows)),
  );
}

async function refreshRooms() {
  const rooms = await api('/api/rooms').catch(() => null);
  if (!rooms) return;
  const box = $('#rooms');
  if (!rooms.length) {
    // Liste 2 sn'de bir yenileniyor: düğme her seferinde yeniden kurulmasın.
    if (box.dataset.bos === '1') return;
    box.dataset.bos = '1';
    box.replaceChildren(
      status?.motor?.kullanilan === 'torrserver'
        ? el('p', { class: 'muted' }, 'Henüz oda yok. Uygulamadan film ara ve oda aç.')
        : el('p', { class: 'muted' }, 'Henüz oda yok. Stremio\'da bir film aç ve ', el('b', { text: '👥 Birlikte İzle' }), '\'yi seç ya da uygulamadan film ara.'),
      el('button', { type: 'button', text: '🖥️ Birlikte İzle uygulamasını aç', onclick: uygulamayiAc }),
    );
    return;
  }
  box.dataset.bos = '0';
  box.replaceChildren(...rooms.map(renderRoom));
}

// ---- config: addons + defaults ------------------------------------------------------

async function saveConfig(next) {
  config = await api('/api/config', { method: 'PUT', body: next });
  renderAddons();
  return config;
}

function moveAddon(i, delta) {
  const addons = [...config.addons];
  const j = i + delta;
  if (j < 0 || j >= addons.length) return;
  [addons[i], addons[j]] = [addons[j], addons[i]];
  saveConfig({ ...config, addons }).catch((err) => alert(err.message));
}

function renderAddons() {
  $('#addons').replaceChildren(...config.addons.map((a, i) => el(
    'li',
    {},
    el('input', {
      type: 'checkbox',
      checked: a.enabled,
      title: 'Açık / kapalı',
      onchange: (e) => {
        const addons = config.addons.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x));
        saveConfig({ ...config, addons }).catch((err) => alert(err.message));
      },
    }),
    el('div', { class: 'name' },
      el('span', { text: a.name }),
      ...a.resources.map((r) => el('span', { class: 'tag', text: r === 'stream' ? 'stream' : 'altyazı' })),
      el('small', { text: a.url })),
    el('button', { type: 'button', text: '↑', title: 'Yukarı', onclick: () => moveAddon(i, -1) }),
    el('button', { type: 'button', text: '↓', title: 'Aşağı', onclick: () => moveAddon(i, 1) }),
    el('button', {
      type: 'button',
      text: 'Sil',
      onclick: () => {
        if (!confirm(`${a.name} silinsin mi?`)) return;
        saveConfig({ ...config, addons: config.addons.filter((_, k) => k !== i) }).catch((err) => alert(err.message));
      },
    }),
  )));
}

$('#addon-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#addon-input');
  const errBox = $('#addon-error');
  errBox.hidden = true;
  let url = input.value.trim().replace(/^stremio:\/\//, 'https://');
  if (!url) return;
  if (!url.endsWith('/manifest.json')) url = `${url.replace(/\/+$/, '')}/manifest.json`;
  try {
    const info = await api('/api/addons/test', { method: 'POST', body: { url } });
    if (!info.resources.length) throw new Error('Bu addon stream veya altyazı sağlamıyor.');
    await saveConfig({ ...config, addons: [...config.addons, { url, name: info.name, enabled: true, resources: info.resources }] });
    input.value = '';
  } catch (err) {
    errBox.textContent = `Eklenemedi: ${err.message}`;
    errBox.hidden = false;
  }
});

function fillDefaults() {
  $('#d-nickname').value = config.nickname;
  $('#d-locked').checked = config.defaults.locked;
  for (const r of document.querySelectorAll('input[name="d-wait"]')) r.checked = r.value === config.defaults.waitMode;
  $('#d-relay').checked = config.defaults.relayEnabled;
  $('#d-relay-limit').value = String(config.defaults.relayLimit);
}

$('#defaults').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#defaults-msg');
  try {
    await saveConfig({
      ...config,
      nickname: $('#d-nickname').value,
      defaults: {
        locked: $('#d-locked').checked,
        waitMode: document.querySelector('input[name="d-wait"]:checked')?.value || 'wait',
        relayEnabled: $('#d-relay').checked,
        relayLimit: Number($('#d-relay-limit').value),
      },
    });
    msg.textContent = 'Kaydedildi ✓ (yeni odalarda geçerli)';
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ---- logs ----------------------------------------------------------------------------

async function refreshLogs() {
  const logs = await api('/api/logs').catch(() => null);
  if (!logs) return;
  const box = $('#logs');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.replaceChildren(...logs.map((l) => el('div', {
    class: l.level,
    text: `${new Date(l.ts).toLocaleTimeString('tr-TR')} ${l.msg}${l.data ? ` ${JSON.stringify(l.data)}` : ''}`,
  })));
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---- start ----------------------------------------------------------------------------

// ---- motor -------------------------------------------------------------------------

const MOTOR_ADI = { torrserver: 'TorrServer', stremio: 'Stremio' };
let motor = null;

async function refreshMotor() {
  try {
    motor = await api('/api/motor');
  } catch {
    $('#motor-ozet').textContent = 'Motor bilgisi alınamadı';
    return;
  }
  const ts = motor.kullanilan === 'torrserver';
  const parcalar = [ts ? `TorrServer ${motor.ts?.surum || ''}`.trim() : 'Stremio (asıl Birlikte İzle ile ortak)'];
  if (ts) {
    parcalar.push(motor.ts?.calisiyor ? 'çalışıyor' : 'kapalı');
    if (motor.ts?.peerPort) parcalar.push(`peer portu ${motor.ts.peerPort}`);
    if (motor.ts?.yenidenAcilis) parcalar.push(`bekçi son 10 dk'da ${motor.ts.yenidenAcilis} kez yeniden açtı`);
  }
  $('#motor-ozet').textContent = parcalar.join(' · ');
  $('#motor-yeniden').hidden = !ts;

  const ob = motor.onbellek;
  $('#motor-onbellek').hidden = !ob;
  if (ob) {
    const sinir = ob.sinir > 0 ? formatSize(ob.sinir) : 'kapalı';
    $('#motor-ob-yazi').textContent = `${formatSize(ob.bayt) || '0 MB'} / ${sinir} · ${ob.film} film`;
    $('#motor-ob-dolu').style.width = ob.sinir > 0 ? `${Math.min(100, (ob.bayt / ob.sinir) * 100)}%` : '0';
    $('#motor-ob-bosalt').disabled = !ob.bayt;
  }

  const liste = $('#motor-torrentler');
  liste.replaceChildren(...(motor.torrentler.length ? motor.torrentler.map((t) => el('li', {},
    el('div', { class: 'name' },
      t.ad || t.infoHash.slice(0, 12),
      el('small', { text: `👤 ${t.peers}${t.bulunan ? ` / ${t.bulunan}` : ''} peer · ↓ ${t.indirmeMbps} Mbps · ↑ ${t.yuklemeMbps} Mbps` })),
    t.izleniyor ? el('span', { class: 'tag', text: 'odada izleniyor' }) : null,
    // Stremio motorunda torrent'ler asıl Birlikte İzle'yle ortak: buradan kapatılmaz.
    ts && !t.izleniyor ? el('button', { type: 'button', text: 'Kapat', onclick: (e) => torrentKapat(t, e.target) }) : null,
  )) : [el('li', { class: 'muted small', text: 'Açık torrent yok.' })]));

  const sec = $('#motor-sec');
  if (document.activeElement !== sec) sec.value = motor.secim || motor.istenen;
  const not = [];
  if (motor.ortam) not.push(`MOTOR=${motor.ortam} ortam değişkeni var: o geçerli.`);
  else if ((motor.secim || motor.istenen) !== motor.istenen) not.push(`Sunucu yeniden başlayınca ${MOTOR_ADI[motor.secim]} kullanılacak.`);
  if (motor.istenen === 'torrserver' && !ts) not.push("TorrServer istendi ama 11470 dolu (Stremio açık): Stremio'yu kapatıp sunucuyu yeniden başlat.");
  $('#motor-sec-not').textContent = not.join(' ');
  $('#motor-sec-not').hidden = !not.length;
  $('#motor-bekci').checked = motor.bekci;
}

async function torrentKapat(t, btn) {
  btn.disabled = true;
  await api('/api/torrent-kapat', { method: 'POST', body: { infoHash: t.infoHash } }).catch((err) => alert(err.message));
  refreshMotor();
}

$('#motor-yeniden').addEventListener('click', async (e) => {
  const rooms = await api('/api/rooms').catch(() => []);
  if (rooms.length && !confirm(`${rooms.length} odada oynatma birkaç saniye duracak. Motor yeniden başlatılsın mı?`)) return;
  e.target.disabled = true;
  e.target.textContent = 'Yeniden başlatılıyor…';
  const r = await api('/api/motor/yeniden-baslat', { method: 'POST' }).catch((err) => ({ error: err.message }));
  e.target.disabled = false;
  e.target.textContent = '🔄 Motoru yeniden başlat';
  if (r?.error) alert(`Yeniden başlatılamadı: ${r.error}`);
  refreshMotor();
});
$('#motor-ob-bosalt').addEventListener('click', async (e) => {
  if (!confirm('Önbellekteki bütün filmler silinsin mi? Sonraki açılışlar yeniden internetten gelir.')) return;
  e.target.disabled = true;
  await api('/api/motor/onbellek-bosalt', { method: 'POST' }).catch((err) => alert(err.message));
  refreshMotor();
});
$('#motor-sec').addEventListener('change', async (e) => {
  await api('/api/motor/ayar', { method: 'PUT', body: { motor: e.target.value } }).catch((err) => alert(err.message));
  refreshMotor();
});
$('#motor-bekci').addEventListener('change', async (e) => {
  await api('/api/motor/ayar', { method: 'PUT', body: { bekci: e.target.checked } }).catch((err) => alert(err.message));
  refreshMotor();
});

config = await api('/api/config');
renderAddons();
fillDefaults();
await refreshStatus();
refreshRooms();
refreshLogs();
refreshMotor();
setInterval(refreshStatus, 3000);
setInterval(refreshMotor, 3000);
setInterval(refreshRooms, 2000);
setInterval(refreshLogs, 5000);
