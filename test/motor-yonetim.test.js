// Motor kartı ve TorrServer yönetimi: seçim dosyası, önbellek kullanımı, ayar yazma, bekçi, peer portu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMotorSecim } from '../src/motor-secim.js';
import { createOnbellek, onbellekYeri, ALT_KLASOR } from '../src/motor/onbellek.js';
import { createOnbellekAyar } from '../src/onbellek-ayar.js';
import { createTorrServer, AYARLAR } from '../src/motor/torrserver.js';

const sessiz = { info() {}, warn() {}, error() {} };
const gecici = (ad) => fs.mkdtempSync(path.join(os.tmpdir(), `${ad}-`));
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));

test('Motor seçimi: varsayılan boş ve bekçi kapalı; yazılan dosyadan geri okunur; geçersiz motor reddedilir', () => {
  const file = path.join(gecici('motor-secim'), 'motor.json');
  const a = createMotorSecim({ file, log: sessiz });
  assert.equal(a.motor(), null);
  assert.equal(a.bekci(), false);
  assert.equal(a.siteden(), true); // kullanıcı istedi (2026-10-07)
  assert.equal(a.yaz({ motor: 'kaplumbaga' }).error, 'badValue');
  assert.deepEqual(a.yaz({ motor: 'stremio', bekci: true, siteden: false }), { ok: true, motor: 'stremio', bekci: true, siteden: false });
  const b = createMotorSecim({ file, log: sessiz });
  assert.equal(b.motor(), 'stremio');
  assert.equal(b.bekci(), true);
  assert.equal(b.siteden(), false);
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

test('Önbellek yeri: seçilen klasörün içinde kendi klasörü; taşıma filmleri götürür, başka dosyalara dokunmaz', async () => {
  const kok = gecici('onbellek-yer');
  const eski = path.join(kok, 'eski');
  const ob = createOnbellek({ klasor: eski, sinirBayt: 1000, blok: 4, log: sessiz });
  fs.mkdirSync(path.join(eski, 'c'.repeat(40), '1'), { recursive: true });
  fs.writeFileSync(path.join(eski, 'c'.repeat(40), '1', '0.blk'), 'abcd');
  fs.writeFileSync(path.join(eski, 'benim.txt'), 'dokunma');
  const secilen = path.join(kok, 'disk');
  fs.mkdirSync(secilen);
  fs.writeFileSync(path.join(secilen, 'baska.txt'), 'x');
  const yeni = onbellekYeri(secilen, null);
  assert.equal(yeni, path.join(secilen, ALT_KLASOR));
  assert.equal(onbellekYeri(yeni, null), yeni, 'kendi klasörü seçilince iç içe açılmaz');
  assert.equal(onbellekYeri(null, eski), eski);
  assert.equal((await ob.tasi('goreli/yol')).error, 'yol');
  const r = await ob.tasi(yeni);
  assert.equal(r.ok, true);
  assert.equal(r.tasinan, 1);
  assert.equal(ob.klasor(), yeni);
  assert.deepEqual(await ob.kullanim(), { bayt: 4, film: 1 });
  assert.equal(fs.readFileSync(path.join(eski, 'benim.txt'), 'utf8'), 'dokunma');
  // Boşaltma yalnız film (torrent kimliği adlı) klasörlerini siler.
  fs.writeFileSync(path.join(yeni, 'not.txt'), 'kalsın');
  await ob.bosalt();
  assert.deepEqual(await ob.kullanim(), { bayt: 0, film: 0 });
  assert.ok(fs.existsSync(path.join(yeni, 'not.txt')));
  assert.ok(fs.existsSync(path.join(secilen, 'baska.txt')));
  fs.rmSync(kok, { recursive: true, force: true });
});

test('Önbellek ayarı: boyut ve yer dosyaya yazılır, geri okunur; göreli yol reddedilir', () => {
  const klasor = gecici('onbellek-ayar');
  const file = path.join(klasor, 'onbellek.json');
  const a = createOnbellekAyar({ file, varsayilanGb: 10, log: sessiz });
  assert.equal(a.klasor(), null);
  const yer = path.join(klasor, 'bir-yer');
  assert.equal(a.klasorAyarla(yer), true);
  assert.equal(a.ayarla(25), true);
  assert.equal(a.klasorAyarla('goreli'), false);
  const b = createOnbellekAyar({ file, varsayilanGb: 10, log: sessiz });
  assert.equal(b.gb(), 25);
  assert.equal(b.klasor(), yer);
  assert.equal(b.klasorAyarla(''), true);
  assert.equal(createOnbellekAyar({ file, log: sessiz }).klasor(), null);
  fs.rmSync(klasor, { recursive: true, force: true });
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

// Küçük ama geçerli bir .torrent (bencode) ve kimliği.
async function ornekTorrent() {
  const crypto = await import('node:crypto');
  const info = Buffer.concat([
    Buffer.from('d6:lengthi20e4:name8:film.mkv12:piece lengthi16384e6:pieces20:'),
    Buffer.alloc(20, 7),
    Buffer.from('e'),
  ]);
  const veri = Buffer.concat([Buffer.from('d8:announce3:abc4:info'), info, Buffer.from('e')]);
  return { veri, ih: crypto.createHash('sha1').update(info).digest('hex') };
}

test('Torrent dosyası: kimlik bencode info bölümünden hesaplanır; bozuk ve yarım veri null', async () => {
  const { infoAraligi, torrentKimligi } = await import('../src/motor/torrent-dosyasi.js');
  const { veri, ih } = await ornekTorrent();
  assert.equal(torrentKimligi(veri), ih);
  assert.equal(infoAraligi(Buffer.from('<!DOCTYPE html>')), null);
  assert.equal(infoAraligi(veri.subarray(0, veri.length - 10)), null);
  assert.equal(infoAraligi(Buffer.from('d4:infoi5')), null);
  assert.equal(infoAraligi(Buffer.from('d999999:x')), null);
});

test('Torrent dosyası: siteden gelen doğrulanır ve diske yazılır, sonraki istek siteye gitmez; yanlış kimlik atılır', async () => {
  const { createTorrentDosyasi } = await import('../src/motor/torrent-dosyasi.js');
  const { veri, ih } = await ornekTorrent();
  const istenen = [];
  const td = createTorrentDosyasi({
    klasor: gecici('torrentler'),
    log: sessiz,
    siteler: [(h) => `https://a/${h}`, (h) => `https://b/${h}`],
    indirImpl: async (url) => {
      istenen.push(url);
      if (url.startsWith('https://a/')) return Buffer.from('d4:infod4:name1:xee'); // başka torrent
      return veri;
    },
  });
  const ilk = await td.bul(ih);
  assert.equal(ilk.kaynak, 'site');
  assert.deepEqual(istenen, [`https://a/${ih}`, `https://b/${ih}`]);
  const ikinci = await td.bul(ih);
  assert.equal(ikinci.kaynak, 'disk');
  assert.equal(istenen.length, 2);
  assert.equal(await td.bul('c'.repeat(40)), null);
});

test('TorrServer: siteden açıksa magnet eklenince film bilgisi dosyası da yüklenir, kapalıysa yüklenmez', async () => {
  const { veri, ih } = await ornekTorrent();
  for (const acik of [true, false]) {
    const d = sahteTs();
    const yuklenen = [];
    const asil = d.fetchImpl;
    d.fetchImpl = async (url, opt = {}) => {
      if (new URL(url).pathname === '/torrent/upload') {
        yuklenen.push(opt.body.get('file'));
        return new Response('{}');
      }
      if (new URL(url).pathname === '/torrents') return new Response('{}');
      return asil(url, opt);
    };
    const { ts } = yeniTs(d, { siteden: () => acik, torrentDosyasi: { bul: async (h) => (h === ih ? { veri, kaynak: 'site', ms: 1 } : null) } });
    await ts.baslat();
    await ts.ekle(ih, []);
    await bekle(50);
    assert.equal(yuklenen.length, acik ? 1 : 0);
    if (acik) assert.equal(Buffer.from(await yuklenen[0].arrayBuffer()).equals(veri), true);
    ts.durdur();
  }
});

test('Torrent dosyası: istekler sırayla gider; üst üste 2 hatadan sonra site bir süre sorulmaz', async () => {
  const { createTorrentDosyasi, HATA } = await import('../src/motor/torrent-dosyasi.js');
  let ayni = 0;
  let enCok = 0;
  let cagri = 0;
  const td = createTorrentDosyasi({
    klasor: gecici('torrentler-sira'),
    log: sessiz,
    siteler: [(h) => `https://a/${h}`],
    indirImpl: async () => {
      cagri++;
      enCok = Math.max(enCok, ++ayni);
      await bekle(20);
      ayni--;
      return HATA;
    },
  });
  await Promise.all(['1', '2', '3', '4'].map((x) => td.bul(x.repeat(40))));
  assert.equal(enCok, 1, 'aynı anda tek istek');
  assert.equal(cagri, 2, 'iki hatadan sonra sorulmuyor');
});
