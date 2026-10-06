// Motor kartı ve TorrServer yönetimi: seçim dosyası, önbellek kullanımı, ayar yazma, bekçi, peer portu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMotorSecim } from '../src/motor-secim.js';
import { createOnbellek } from '../src/motor/onbellek.js';
import { createTorrServer, AYARLAR } from '../src/motor/torrserver.js';

const sessiz = { info() {}, warn() {}, error() {} };
const gecici = (ad) => fs.mkdtempSync(path.join(os.tmpdir(), `${ad}-`));
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

test('Motor seçimi: varsayılan boş ve bekçi kapalı; yazılan dosyadan geri okunur; geçersiz motor reddedilir', () => {
  const file = path.join(gecici('motor-secim'), 'motor.json');
  const a = createMotorSecim({ file, log: sessiz });
  assert.equal(a.motor(), null);
  assert.equal(a.bekci(), false);
  assert.equal(a.yaz({ motor: 'kaplumbaga' }).error, 'badValue');
  assert.deepEqual(a.yaz({ motor: 'stremio', bekci: true }), { ok: true, motor: 'stremio', bekci: true });
  const b = createMotorSecim({ file, log: sessiz });
  assert.equal(b.motor(), 'stremio');
  assert.equal(b.bekci(), true);
});

test('Önbellek: kullanım toplam bayt ve film sayısını verir, boşalt hepsini siler', async () => {
  const klasor = gecici('onbellek-kullanim');
  const ob = createOnbellek({ klasor, sinirBayt: 1000, blok: 4, log: sessiz });
  for (const [ih, no] of [['a'.repeat(40), 0], ['a'.repeat(40), 1], ['b'.repeat(40), 0]]) {
    fs.mkdirSync(path.join(klasor, ih, '1'), { recursive: true });
    fs.writeFileSync(path.join(klasor, ih, '1', `${no}.blk`), 'abcd');
  }
  assert.deepEqual(await ob.kullanim(), { bayt: 12, film: 2 });
  assert.equal(ob.sinir(), 1000);
  await ob.bosalt();
  assert.deepEqual(await ob.kullanim(), { bayt: 0, film: 0 });
});

// Sahte TorrServer: /echo, /settings (get/set), /torrents (list). spawn sahte süreç döndürür.
function sahteTs({ ayar = {}, torrentler = [] } = {}) {
  const d = { ayar: { ...ayar }, torrentler, setSayisi: 0, ayakta: false, surecler: [] };
  d.fetchImpl = async (url, opt = {}) => {
    const yol = new URL(url).pathname;
    if (yol === '/echo') {
      if (!d.ayakta) throw new Error('kapalı');
      return new Response('ok');
    }
    if (yol === '/shutdown') return new Response('');
    const govde = JSON.parse(opt.body || '{}');
    if (yol === '/settings' && govde.action === 'get') return Response.json(d.ayar);
    if (yol === '/settings' && govde.action === 'set') {
      d.setSayisi++;
      d.ayar = govde.sets;
      return Response.json({});
    }
    if (yol === '/torrents' && govde.action === 'list') return Response.json(d.torrentler);
    return new Response('', { status: 404 });
  };
  d.spawnImpl = () => {
    const s = new EventEmitter();
    s.kill = () => { d.ayakta = false; };
    d.surecler.push(s);
    d.ayakta = true;
    return s;
  };
  return d;
}

function yeniTs(d, ek = {}) {
  const klasor = gecici('ts');
  fs.mkdirSync(path.join(klasor, 'araclar'), { recursive: true });
  fs.writeFileSync(path.join(klasor, 'araclar', 'TorrServer.exe'), ''); // indirme olmasın
  return {
    klasor,
    ts: createTorrServer({ klasor, log: sessiz, fetchImpl: d.fetchImpl, spawnImpl: d.spawnImpl, portBosMu: async () => true, ...ek }),
  };
}

test('TorrServer: ayarlar değişmemişse yazılmaz (yazmak açık torrentleri kapatır); peer portu saklanır, güncel tracker\'lar öne konur', async () => {
  const d = sahteTs();
  const { klasor, ts } = yeniTs(d, { trackerlar: () => ['udp://yeni.example:1/announce'] });
  await ts.baslat();
  assert.equal(d.setSayisi, 1);
  const port = d.ayar.PeersListenPort;
  assert.ok(port >= 20000 && port < 60000);
  assert.equal(fs.readFileSync(path.join(klasor, 'torrserver', 'peer-port.txt'), 'utf8'), String(port));
  assert.equal(d.ayar.DefaultTrackers.split('\n')[0], 'udp://yeni.example:1/announce');
  assert.equal(d.ayar.ConnectionsLimit, AYARLAR.ConnectionsLimit);
  assert.equal((await ts.durum()).peerPort, port);

  // Aynı klasörle yeniden açılış: aynı port, ayar yazılmıyor.
  const ts2 = createTorrServer({ klasor, log: sessiz, fetchImpl: d.fetchImpl, spawnImpl: d.spawnImpl, portBosMu: async () => false, trackerlar: () => ['udp://yeni.example:1/announce'] });
  await ts2.baslat();
  assert.equal(d.setSayisi, 1);
  assert.equal(d.ayar.PeersListenPort, port);
  ts.durdur();
  ts2.durdur();
});

test('TorrServer: izlenirken yükleme sınırı bekletilir (torrent kapanmasın), torrent yokken hemen yazılır', async () => {
  const d = sahteTs({ torrentler: [{ hash: 'a'.repeat(40) }] });
  const { ts } = yeniTs(d);
  await ts.baslat();
  const once = d.setSayisi;
  const r = await ts.yuklemeSiniriKoy(8);
  assert.equal(r.bekliyor, true);
  assert.equal(r.mbps, 8);
  assert.equal(d.setSayisi, once);
  assert.equal(await ts.yuklemeSiniri(), 8);

  d.torrentler = [];
  const r2 = await ts.yuklemeSiniriKoy(null);
  assert.equal(r2.bekliyor, undefined);
  assert.equal(d.setSayisi, once + 1);
  assert.equal(d.ayar.UploadRateLimit, 0);
  assert.equal(await ts.yuklemeSiniri(), null);
  ts.durdur();
});

test('TorrServer bekçisi: açıksa beklenmedik kapanışta yeniden açar; durdur() ve kapalı bekçi açmaz', async () => {
  const d = sahteTs();
  let bekci = false;
  const { ts } = yeniTs(d, { bekci: () => bekci });
  await ts.baslat();
  d.ayakta = false;
  d.surecler.at(-1).emit('exit', 1);
  await bekle(2300);
  assert.equal(d.surecler.length, 1, 'bekçi kapalıyken yeniden açılmamalı');

  bekci = true;
  await ts.baslat();
  assert.equal(d.surecler.length, 2);
  d.ayakta = false;
  d.surecler.at(-1).emit('exit', 1);
  await bekle(2300);
  assert.equal(d.surecler.length, 3, 'bekçi açıkken yeniden açılmalı');
  assert.equal((await ts.durum()).yenidenAcilis, 1);

  // Bilerek kapatma: eski sürecin geç gelen exit'i bekçiyi tetiklemesin.
  const son = d.surecler.at(-1);
  ts.durdur();
  son.emit('exit', 0);
  await bekle(2300);
  assert.equal(d.surecler.length, 3);
});
