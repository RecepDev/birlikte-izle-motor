import { api, el, $, copy, formatSize } from './api.js';
import { onayla, sor } from '/js/diyalog.js';

const STATE_TEXT = {
  ready: '▶ hazır', loading: '⏳ yükleniyor', buffering: '⏳ donuyor', error: '⚠️ hata',
  noStremio: '🚫 motor yok', idle: '💤 bekliyor',
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
    $('#st-stremio').textContent = status.stremio ? 'açık' : 'kapalı';
  } else if (motor?.istenen === 'torrserver') {
    // Kopya TorrServer'la açılmak istedi ama 11470 doluydu (Stremio açık): Stremio'yla çalışıyor.
    $('#st-motor-ad').textContent = 'Video motoru';
    $('#st-stremio-dot').className = 'dot warn';
    $('#st-stremio').textContent = 'başka bir program 11470 portunu tutuyor: onu kapatıp sunucuyu yeniden başlat';
  } else {
    $('#st-motor-ad').textContent = 'Video motoru';
    $('#st-stremio').textContent = status.stremio ? 'açık' : 'kapalı';
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
  if (!await onayla(`Birlikte İzle sunucusu kapatılsın mı?${window.kabuk?.cik ? ' Uygulama da kapanır.' : ''}${warn}`, { tamam: 'Kapat', tehlike: true })) return;
  await api('/api/shutdown', { method: 'POST' }).catch(() => {});
  // Panel penceresini sunucu kapatıyor; normal tarayıcı sekmesindeyse de kapanmayı dene.
  if (window.kabuk?.cik) return window.kabuk.cik();
  window.close();
  document.body.replaceChildren(el('main', { class: 'narrow' }, el('section', { class: 'card' },
    el('h2', { text: 'Sunucu kapatıldı' }),
    el('p', { class: 'muted', text: 'Bu pencereyi kapatabilirsin. Tekrar açmak için masaüstündeki "Birlikte İzle" kısayolunu kullan.' }))));
});

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
    el('button', {
      type: 'button',
      text: '⚙️ Ayarla',
      title: 'Eklentinin kendi ayar sayfasını tarayıcıda aç. Ayarlayınca çıkan kurulum linkini kopyalayıp aşağıya yapıştır.',
      onclick: () => window.open(`${a.url.replace(/\/manifest\.json$/, '')}/configure`, '_blank', 'noopener'),
    }),
    el('button', { type: 'button', text: '↑', title: 'Yukarı', onclick: () => moveAddon(i, -1) }),
    el('button', { type: 'button', text: '↓', title: 'Aşağı', onclick: () => moveAddon(i, 1) }),
    el('button', {
      type: 'button',
      text: 'Sil',
      onclick: async () => {
        if (!await onayla(`${a.name} silinsin mi?`)) return;
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
    // Aynı eklentinin (aynı site, ör. torrentio.strem.fun) ayarlı adresi yapıştırıldıysa yenisini eklemek yerine
    // mevcut satırı güncelle: sıra ve açık/kapalı durumu korunur.
    const host = new URL(url).host;
    const mevcut = config.addons.findIndex((x) => { try { return new URL(x.url).host === host; } catch { return false; } });
    if (mevcut >= 0 && config.addons[mevcut].url !== url) {
      if (await onayla(`"${config.addons[mevcut].name}" zaten ekli. Ayarları yeni adresle güncellensin mi?
(İptal: ayrı bir eklenti olarak ekler.)`, { tamam: 'Güncelle', iptal: 'Ayrı ekle' })) {
        const addons = config.addons.map((x, k) => (k === mevcut ? { ...x, url, name: info.name, resources: info.resources } : x));
        await saveConfig({ ...config, addons });
        input.value = '';
        return;
      }
    }
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
  const parcalar = [ts ? `TorrServer ${motor.ts?.surum || ''}`.trim() : 'Harici motor'];
  if (ts) {
    parcalar.push(motor.ts?.calisiyor ? 'çalışıyor' : 'kapalı');
    if (motor.ts?.peerPort) parcalar.push(`peer portu ${motor.ts.peerPort}`);
    if (motor.ts?.yenidenAcilis) parcalar.push(`bekçi son 10 dk'da ${motor.ts.yenidenAcilis} kez yeniden açtı`);
  }
  $('#motor-ozet').textContent = parcalar.join(' · ');
  $('#motor-yeniden').hidden = !ts;

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
  if (motor.istenen === 'torrserver' && !ts) not.push('Video motoru açılamadı: 11470 portu başka bir programda. Onu kapatıp sunucuyu yeniden başlat.');
  $('#motor-sec-not').textContent = not.join(' ');
  $('#motor-sec-not').hidden = !not.length;
  $('#srv-motor-bekci').checked = motor.bekci;
  $('#motor-siteden').checked = motor.siteden;
}

async function torrentKapat(t, btn) {
  btn.disabled = true;
  await api('/api/torrent-kapat', { method: 'POST', body: { infoHash: t.infoHash } }).catch((err) => alert(err.message));
  refreshMotor();
}

$('#motor-yeniden').addEventListener('click', async (e) => {
  const rooms = await api('/api/rooms').catch(() => []);
  if (rooms.length && !await onayla(`${rooms.length} odada oynatma birkaç saniye duracak. Motor yeniden başlatılsın mı?`)) return;
  e.target.disabled = true;
  e.target.textContent = 'Yeniden başlatılıyor…';
  const r = await api('/api/motor/yeniden-baslat', { method: 'POST' }).catch((err) => ({ error: err.message }));
  e.target.disabled = false;
  e.target.textContent = '🔄 Motoru yeniden başlat';
  if (r?.error) alert(`Yeniden başlatılamadı: ${r.error}`);
  refreshMotor();
});
$('#motor-sec').addEventListener('change', async (e) => {
  await api('/api/motor/ayar', { method: 'PUT', body: { motor: e.target.value } }).catch((err) => alert(err.message));
  refreshMotor();
});
$('#srv-motor-bekci').addEventListener('change', async (e) => {
  await api('/api/motor/ayar', { method: 'PUT', body: { bekci: e.target.checked } }).catch((err) => alert(err.message));
  refreshMotor();
});
$('#motor-siteden').addEventListener('change', async (e) => {
  await api('/api/motor/ayar', { method: 'PUT', body: { siteden: e.target.checked } }).catch((err) => alert(err.message));
  refreshMotor();
});

// Sunucu görünümü uygulama kabuğunda (uygulama.html); gizliyken yoklama yapılmaz.
const sunucuGizli = () => document.hidden || $('#gorunum-sunucu')?.hidden;

config = await api('/api/config');
renderAddons();
fillDefaults();
await refreshStatus();
refreshLogs();
refreshMotor();
setInterval(() => { if (!sunucuGizli()) refreshStatus(); }, 3000);
setInterval(() => { if (!sunucuGizli()) refreshMotor(); }, 3000);
setInterval(() => { if (!sunucuGizli()) refreshLogs(); }, 5000);
