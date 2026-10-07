// Yaşanmış sorunların tekrarlamaması için (her testin başında o sorun yazıyor).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createStremioLocal } from '../src/stremio-local.js';
import { stremioTakildiMi } from '../src/takilma.js';
import { kapatilacaklar, dokun, kaydet } from '../src/bizim-torrentler.js';
import { createTorrentHiz } from '../src/torrent-hiz.js';
import { createPlayer } from '../public/js/player.js';
import { createSync } from '../public/js/sync.js';

const require = createRequire(import.meta.url);
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (c) => c.repeat(40);

// ---- Sahte <video>: köprülerin (mpv/ExoPlayer) sayfaya gösterdiği kadarı ----
function sahteVideo() {
  const v = new EventTarget();
  Object.assign(v, {
    src: '', currentTime: 0, duration: 3000, paused: true, seeking: false, readyState: 4, playbackRate: 1,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    load() {}, removeAttribute() { this.src = ''; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  });
  v.olay = (ad) => v.dispatchEvent(new Event(ad));
  return v;
}

test('Stremio çöküyordu: aynı torrent kısa aralıkla iki kez kapatılmıyor', async () => {
  const istekler = [];
  const local = createStremioLocal({ fetchImpl: async (url) => { istekler.push(url); return { ok: true }; } });
  await Promise.all([local.removeTorrent({ infoHash: hash('a') }), local.removeTorrent({ infoHash: hash('a') })]);
  await local.removeTorrent({ infoHash: hash('a') });
  await local.removeTorrent({ infoHash: hash('b') });
  assert.equal(istekler.filter((u) => u.includes(hash('a'))).length, 1);
  assert.equal(istekler.filter((u) => u.includes(hash('b'))).length, 1);
});

function odaTaklidi({ bekleyen = true, dolu = true, bosSure = 0 } = {}) {
  const simdi = 1_000_000;
  return {
    hostStreamId: 's1', hadSpeedFor: null, streams: [{ streamId: 's1', kind: 'torrent', infoHash: hash('c') }],
    users: new Map([['u', {}]]), emptySince: dolu ? null : simdi - bosSure, now: () => simdi,
    connectedUsers: () => (dolu ? [{ status: { state: bekleyen ? 'buffering' : 'ready' } }] : []),
    statsStreamIds: () => ['s1'],
  };
}

test('Bekçi Stremio\'yu kapatıyordu: yeni açılan (hiç indirmemiş) torrent takılma sayılmıyor', () => {
  const oda = odaTaklidi();
  assert.equal(stremioTakildiMi(oda, { peers: 5, downMbps: 0 }), false, 'hiç indirmedi');
  assert.equal(stremioTakildiMi(oda, null), false, 'istatistik yok');
  stremioTakildiMi(oda, { peers: 20, downMbps: 12 }); // indiriyordu
  assert.equal(stremioTakildiMi(oda, { peers: 0, downMbps: 0 }), false, 'peer yok: ölü torrent, restart işe yaramaz');
  assert.equal(stremioTakildiMi(oda, { peers: 8, downMbps: 0 }), true, 'indiriyordu, peer var, veri yok');
  assert.equal(stremioTakildiMi(odaTaklidi({ bekleyen: false }), { peers: 8, downMbps: 0 }), false, 'kimse beklemiyor');
});

test('Arkada internet yiyordu: sahipsiz torrent kapatılıyor, izlenen ve yeni dokunulan kalıyor', () => {
  const [izlenen, sahipsiz, yeni, yabanci] = [hash('d'), hash('e'), hash('f'), hash('9')];
  kaydet([{ kind: 'torrent', infoHash: sahipsiz }]);
  dokun(yeni);
  const oda = odaTaklidi({ bekleyen: false });
  oda.streams = [{ streamId: 's1', kind: 'torrent', infoHash: izlenen }];
  const sonuc = kapatilacaklar({ acik: [izlenen, sahipsiz, yeni, yabanci], rooms: [oda] });
  assert.deepEqual(sonuc, [sahipsiz], 'yabancı (kullanıcının kendi açtığı) torrent\'e dokunulmaz');
});

test('Odadan çıkınca torrent kapanmıyordu: herkes çıkıp 30 sn geçince odanın torrent\'i kapatılıyor', () => {
  const h = hash('7');
  const yeniCikti = odaTaklidi({ dolu: false, bosSure: 10_000 });
  yeniCikti.streams = [{ streamId: 's1', kind: 'torrent', infoHash: h }];
  assert.deepEqual(kapatilacaklar({ acik: [h], rooms: [yeniCikti] }), [], 'sayfa yenileme payı');
  const cikali = odaTaklidi({ dolu: false, bosSure: 40_000 });
  cikali.streams = yeniCikti.streams;
  assert.deepEqual(kapatilacaklar({ acik: [h], rooms: [cikali] }), [h]);
});

test('Modem boğuluyordu: Stremio bağlantı sınırı 80\'e (250\'den) iniyor', async () => {
  const gonderilen = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'POST') gonderilen.push(JSON.parse(opts.body));
    return { json: async () => ({ values: { btMaxConnections: 250, btMinPeersForStable: 30, btDownloadSpeedSoftLimit: 25 * 1024 * 1024 } }), text: async () => '' };
  };
  const hiz = createTorrentHiz({ file: 'yok/olmayan.json', log: { info() {}, warn() {} }, fetchImpl });
  await hiz.stremioAyarla();
  assert.equal(gonderilen.at(-1)?.btMaxConnections, 80);
});

test('Ara katman motorun bağlantı başlıklarını mpv’ye aktarmaz (keep-alive görünce mpv sarmada dosyanın kalanını indiriyordu)', () => {
  const vekil = require('../masaustu/electron/stremio-vekil.cjs');
  const giden = vekil.aktarilan({
    'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': '6685592673',
    'content-range': 'bytes 0-6685592672/6685592673', connection: 'keep-alive', 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked',
  });
  assert.deepEqual(Object.keys(giden).sort(), ['accept-ranges', 'content-length', 'content-range', 'content-type']);
});

test('Masaüstü 4 GB istiyordu: parça boyu "Önünü hazırla" süresine göre', () => {
  const vekil = require('../masaustu/electron/stremio-vekil.cjs');
  const GB = 1024 ** 3;
  vekil.ayarla({ sure: 3000, onbellek: 180 }); // 50 dk, 3 dk önü
  const k4 = vekil.parcaBoyu(30 * GB); // ~80 Mbps 4K
  assert.ok(k4 > 1.5 * GB && k4 < 3 * GB, `4K parça ${Math.round(k4 / 1e6)} MB`);
  const hd = vekil.parcaBoyu(3 * GB);
  assert.ok(hd < 0.4 * GB, `1080p parça ${Math.round(hd / 1e6)} MB`);
  assert.ok(vekil.parcaBoyu(100 * GB) <= 4 * GB, 'üst sınır');
});

test('Telefon takılınca oda beklemiyordu: sık gelen "waiting" kişiyi "yükleniyor" yapıyor', async () => {
  const v = sahteVideo();
  const durumlar = [];
  const player = createPlayer({ video: v, onStatus: (s) => durumlar.push(s.state) });
  await player.load({ kind: 'http', url: 'http://x/v.mkv' });
  v.olay('canplay');
  assert.equal(player.status().state, 'ready');
  v.readyState = 2;
  for (let i = 0; i < 8; i++) { v.olay('waiting'); await bekle(200); } // köprü 0,2 sn'de bir
  assert.equal(player.status().state, 'buffering');
  v.readyState = 4;
  v.olay('canplay');
  assert.equal(player.status().state, 'ready');
});

test('Takılmadan önce durdurma: hold "yükleniyor" yapıyor, bırakınca hazır', async () => {
  const v = sahteVideo();
  const player = createPlayer({ video: v, onStatus: () => {} });
  await player.load({ kind: 'http', url: 'http://x/v.mkv' });
  v.olay('canplay');
  player.hold(true);
  assert.equal(player.status().state, 'buffering');
  v.olay('canplay'); // hazır olayı tutmayı bozmasın
  assert.equal(player.status().state, 'buffering');
  player.hold(false);
  assert.equal(player.status().state, 'ready');
});

test('Sonsuz sarma: geç gelen "seeked" kişinin sarması sanılıp odaya yollanmıyor', async () => {
  const v = sahteVideo();
  const yollanan = [];
  const sync = createSync({
    video: v, request: async (ev, p) => { yollanan.push([ev, p]); return {}; }, canControl: () => true,
    onBlocked() {}, onError() {},
  });
  sync.setPlayback({ paused: true, position: 500, updatedAt: Date.now() }, false);
  assert.equal(v.currentTime, 500, 'odanın yerine sarıldı');
  await bekle(1500); // telefonda seeked yeni yer inince, saniyeler sonra geliyor
  v.olay('seeked');
  assert.deepEqual(yollanan.filter(([ev]) => ev === 'control'), []);
  sync.stop();
});

test('Telefon duraklatılmışken 17 sn geride "hazır" kalıyordu: yerinde değilse yeniden sarılıyor', async () => {
  const v = sahteVideo();
  const sync = createSync({ video: v, request: async () => ({}), canControl: () => false, onBlocked() {}, onError() {} });
  sync.setPlayback({ paused: true, position: 800, updatedAt: Date.now() }, false);
  v.currentTime = 783; // sarma kayboldu
  await bekle(5300); // tick 1 sn, sarma arası en az 4 sn
  assert.equal(v.currentTime, 800);
  sync.stop();
});

test('Yayında siyah ekran: masaüstü ve telefon stilleri yayın videosunu gizlemiyor', async () => {
  const fs = await import('node:fs');
  const masaustu = fs.readFileSync(new URL('../masaustu/electron/masaustu.css', import.meta.url), 'utf8');
  const kopru = fs.readFileSync(new URL('../android/app/src/main/assets/kopru.js', import.meta.url), 'utf8');
  // ".player video" #yayin-video'yu da kapsıyordu (masaüstünde yükseklik 0, telefonda görünmez).
  for (const [ad, css] of [['masaustu.css', masaustu], ['kopru.js', kopru]]) {
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\.player video\b/, `${ad} tüm videolara kural yazmasın`);
  }
});

test('Yayın açıkken girince: katılma cevabında yayın durumu var', async () => {
  const { createYayin } = await import('../src/yayin.js');
  const y = createYayin();
  const oda = { id: 'R', hostUserId: 'h' };
  assert.deepEqual(y.katilmaDurumu(oda), { aktif: false });
  assert.equal(typeof y.durum, 'function', 'eski durum(roomId) da duruyor');
});
