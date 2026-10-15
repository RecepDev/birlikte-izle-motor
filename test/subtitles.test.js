import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSubtitleService, createSubtitleRouter, guessLang } from '../src/subtitles.js';
import { createRoomManager } from '../src/rooms.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const IH = 'c'.repeat(40);
const STREAMS = [
  {
    streamId: 's1', kind: 'torrent', infoHash: IH, fileIdx: 0, sources: [], addonName: 'Torrentio',
    subtitles: [{ id: 'emb', url: 'https://stream.example/tr.srt', lang: 'tur' }],
  },
  { streamId: 's2', kind: 'http', url: 'https://rd/x', addonName: 'RD', subtitles: [] },
];

function makeRoom() {
  const mgr = createRoomManager();
  const { room, creatorToken } = mgr.create({
    type: 'movie', contentId: 'tt9', meta: {}, streams: STREAMS, hostStreamId: 's1', settings: DEFAULT_CONFIG.defaults,
  });
  const host = room.join({ token: creatorToken, name: 'Host', socketId: 'h' }).user;
  return { mgr, room, host, creatorToken };
}

function fakeAddons() {
  const calls = [];
  return {
    calls,
    subtitles: async (list, type, id, video) => {
      calls.push(video || null);
      if (video) {
        return {
          subtitles: [
            { id: '3', url: 'https://os/3.srt', lang: 'tur', addonName: 'OS' },
            { id: '1', url: 'https://os/1.srt', lang: 'eng', addonName: 'OS' },
          ],
          errors: [],
        };
      }
      return {
        subtitles: [
          { id: '1', url: 'https://os/1.srt', lang: 'eng', addonName: 'OS' },
          { id: '2', url: 'https://os/2.srt', lang: 'ger', addonName: 'OS' },
        ],
        errors: [],
      };
    },
  };
}

const silentLog = { info() {}, warn() {}, error() {} };

test('guessLang reads common file name markers', () => {
  assert.equal(guessLang('Film.2024.tr.srt'), 'tur');
  assert.equal(guessLang('film-turkish.srt'), 'tur');
  assert.equal(guessLang('Film.ENG.srt'), 'eng');
  assert.equal(guessLang('film.srt'), 'und');
});

test('refresh publishes plain list, then hash-matched list', async () => {
  const { room } = makeRoom();
  const addons = fakeAddons();
  const service = createSubtitleService({
    addons,
    getAddons: () => [],
    stremioLocal: { opensubHash: async (url) => (url.includes(IH) ? { hash: 'h1', size: 5 } : null) },
    log: silentLog,
  });
  const batches = [];
  await service.refresh(room, (msgs) => batches.push(msgs));
  assert.equal(batches.length, 2);
  assert.deepEqual(addons.calls, [null, { hash: 'h1', size: 5 }]);

  const list = room.snapshot(room.hostUserId).subtitles;
  // Turkish first (stream-provided and hash-only are matched), then English, then German.
  assert.deepEqual(list.map((s) => [s.lang, s.source, s.matched]), [
    ['tur', 'stream', true],
    ['tur', 'addon', true],
    ['eng', 'addon', false],
    ['ger', 'addon', false],
  ]);
  const ev = batches[1].find((m) => m.event === 'subtitles');
  assert.equal(ev.data.subtitles.length, 4);
  assert.equal(JSON.stringify(ev.data).includes('https://'), false, 'urls stay on the server');
});

test('subIds stay stable across refreshes', async () => {
  const { room } = makeRoom();
  const service = createSubtitleService({
    addons: fakeAddons(), getAddons: () => [], stremioLocal: { opensubHash: async () => null }, log: silentLog,
  });
  await service.refresh(room, () => {});
  const first = room.subtitles.map((s) => s.subId).join();
  await service.refresh(room, () => {});
  assert.equal(room.subtitles.map((s) => s.subId).join(), first);
});

test('getVtt downloads, decodes windows-1254 and caches', async () => {
  const { room } = makeRoom();
  let fetches = 0;
  const srt = new Uint8Array([
    ...new TextEncoder().encode('1\r\n00:00:01,000 --> 00:00:02,000\r\n'),
    0xde, 0xf0, 0xfd, // "Şğı"
    0x0d, 0x0a,
  ]);
  const service = createSubtitleService({
    addons: fakeAddons(),
    getAddons: () => [],
    stremioLocal: { opensubHash: async () => null },
    log: silentLog,
    fetchImpl: async () => {
      fetches++;
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => srt.buffer };
    },
  });
  await service.refresh(room, () => {});
  const tur = room.subtitles.find((s) => s.lang === 'tur');
  const vtt = await service.getVtt(room, tur.subId);
  assert.equal(vtt, 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nŞğı\n');
  await service.getVtt(room, tur.subId);
  assert.equal(fetches, 1);
  assert.equal(await service.getVtt(room, 'nope'), null);
});

test('setHostSubtitle validates and broadcasts; missing subtitle resets selection', async () => {
  const { room, host } = makeRoom();
  const service = createSubtitleService({
    addons: fakeAddons(), getAddons: () => [], stremioLocal: { opensubHash: async () => null }, log: silentLog,
  });
  await service.refresh(room, () => {});
  const guest = room.join({ token: 'guest-token-xx', name: 'G', socketId: 'g' }).user;
  const subId = room.subtitles[0].subId;
  assert.deepEqual(room.setHostSubtitle(guest.id, { subId, offset: 0 }), { error: 'notHost' });
  assert.deepEqual(room.setHostSubtitle(host.id, { subId: 'zz', offset: 0 }), { error: 'badSubtitle' });
  assert.deepEqual(room.setHostSubtitle(host.id, { subId, offset: 9999 }), { error: 'badOffset' });
  const res = room.setHostSubtitle(host.id, { subId, offset: 1.5 });
  assert.deepEqual(res.msgs.find((m) => m.event === 'hostSubtitle').data, { subId, offset: 1.5 });
  assert.equal(res.msgs.filter((m) => m.event === 'chat').length, 1);
  const again = room.setHostSubtitle(host.id, { subId, offset: 2 });
  assert.equal(again.msgs.filter((m) => m.event === 'chat').length, 0, 'offset change is quiet');

  room.setSubtitles([]);
  assert.equal(room.hostSubtitle, null);
});

async function withRouter(fn) {
  const { room, host, creatorToken } = makeRoom();
  const service = createSubtitleService({
    addons: fakeAddons(), getAddons: () => [], stremioLocal: { opensubHash: async () => null }, log: silentLog,
  });
  const dispatched = [];
  const rooms = { get: (id) => (id === room.id ? room : undefined) };
  const app = express();
  app.use(createSubtitleRouter({ rooms, service, dispatch: (r, msgs) => dispatched.push(msgs), log: silentLog }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, room, host, creatorToken, dispatched });
  } finally {
    server.close();
  }
}

test('host upload is shared; guests and strangers are rejected', async () => {
  await withRouter(async ({ base, room, creatorToken, dispatched }) => {
    room.join({ token: 'guest-token-xx', name: 'G', socketId: 'g' });
    const body = new TextEncoder().encode('1\n00:00:01,000 --> 00:00:02,000\nmerhaba\n');
    const post = (token, name = 'film.tr.srt') =>
      fetch(`${base}/room/${room.id}/subtitles`, {
        method: 'POST',
        headers: { 'x-user-token': token, 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' },
        body,
      });
    assert.equal((await post('guest-token-xx')).status, 403);
    assert.equal((await post('stranger-token')).status, 403);
    const ok = await post(creatorToken);
    assert.equal(ok.status, 200);
    const { subId } = await ok.json();
    const entry = room.subtitles.find((s) => s.subId === subId);
    assert.equal(entry.lang, 'tur');
    assert.equal(entry.source, 'upload');
    assert.equal(dispatched.length, 1);

    const vtt = await fetch(`${base}/sub/${room.id}/${subId}.vtt`);
    assert.equal(vtt.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.match(await vtt.text(), /merhaba/);
    assert.equal((await fetch(`${base}/sub/${room.id}/nope.vtt`)).status, 404);
    assert.equal((await fetch(`${base}/sub/NOROOM/${subId}.vtt`)).status, 404);
  });
});

test('uploads over 2 MB are rejected', async () => {
  await withRouter(async ({ base, room, creatorToken }) => {
    const res = await fetch(`${base}/room/${room.id}/subtitles`, {
      method: 'POST',
      headers: { 'x-user-token': creatorToken, 'x-filename': 'big.srt', 'content-type': 'application/octet-stream' },
      body: new Uint8Array(2 * 1024 * 1024 + 10),
    });
    assert.equal(res.status, 413);
  });
});

// ---- ikinci altyazının hizalanması ---------------------------------------------------

// Aynı repliklerin iki dili: hedefin zamanları kaydırılmış olarak üretiliyor.
function altyaziCifti(kaydirma, { kirilmaSn = null, kirilmaEk = 0 } = {}) {
  const yaz = (t) => {
    const s = Math.max(0, t);
    const sa = String(Math.floor(s / 3600)).padStart(2, '0');
    const dk = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sn = String(Math.floor(s % 60)).padStart(2, '0');
    const ms = String(Math.round((s - Math.floor(s)) * 1000)).padStart(3, '0');
    return `${sa}:${dk}:${sn}.${ms}`;
  };
  const ref = ['WEBVTT', ''];
  const hedef = ['WEBVTT', ''];
  let t = 20;
  for (let i = 0; i < 200; i += 1) {
    t += 2 + (i % 7) * 0.7; // düzensiz aralıklar: parmak izi oluşsun
    const sure = 1.2 + (i % 3) * 0.4;
    ref.push(`${yaz(t)} --> ${yaz(t + sure)}`, `line ${i}`, '');
    const ek = kirilmaSn !== null && t > kirilmaSn ? kirilmaEk : 0;
    hedef.push(`${yaz(t + kaydirma + ek)} --> ${yaz(t + sure + kaydirma + ek)}`, `satır ${i}`, '');
    t += sure;
  }
  return { ref: ref.join('\n'), hedef: hedef.join('\n') };
}

function hizaServisi(dosyalar) {
  const { room } = makeRoom();
  const service = createSubtitleService({
    addons: {
      subtitles: async () => ({
        subtitles: [
          { id: 'e', url: 'https://os/eng.srt', lang: 'eng', addonName: 'OS' },
          { id: 't', url: 'https://os/tur.srt', lang: 'tur', addonName: 'OS' },
        ],
        errors: [],
      }),
    },
    getAddons: () => [],
    stremioLocal: { opensubHash: async () => null },
    log: silentLog,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(dosyalar[url] ?? 'WEBVTT\n').buffer,
    }),
  });
  return { room, service };
}

test('ikinci altyazı birincisine göre hizalanır ve plan saklanır', async () => {
  const { ref, hedef } = altyaziCifti(6.5);
  const { room, service } = hizaServisi({ 'https://os/eng.srt': ref, 'https://os/tur.srt': hedef });
  await service.refresh(room, () => {});
  const eng = room.subtitles.find((s) => s.lang === 'eng' && s.source === 'addon');
  const tur = room.subtitles.find((s) => s.lang === 'tur' && s.source === 'addon');

  const { vtt, plan } = await service.getHizaliVtt(room, tur.subId, eng.subId);
  assert.equal(plan.ok, true);
  assert.equal(plan.mod, 'sabit');
  assert.ok(Math.abs(plan.kaydirma + 6.5) < 0.1, `kaydırma ${plan.kaydirma}`);
  assert.ok(plan.guven > 0.95);
  // Hizalanmış dosyanın ilk cue'su referansın ilk cue'suyla aynı ana geliyor.
  const ilk = (metin) => metin.match(/(\d{2}:\d{2}:\d{2}\.\d{3}) -->/)[1];
  assert.equal(ilk(vtt), ilk(ref));
  // Metin korunuyor (yalnız zamanlar yeniden yazıldı).
  assert.match(vtt, /satır 0/);

  // İkinci çağrı hesabı tekrarlamıyor: aynı plan nesnesi dönüyor.
  const tekrar = await service.getHizaliVtt(room, tur.subId, eng.subId);
  assert.equal(tekrar.plan, plan);
});

test('film ortasında değişen kayma parçalı hizalanır', async () => {
  const { ref, hedef } = altyaziCifti(2, { kirilmaSn: 400, kirilmaEk: 9 });
  const { room, service } = hizaServisi({ 'https://os/eng.srt': ref, 'https://os/tur.srt': hedef });
  await service.refresh(room, () => {});
  const eng = room.subtitles.find((s) => s.lang === 'eng' && s.source === 'addon');
  const tur = room.subtitles.find((s) => s.lang === 'tur' && s.source === 'addon');
  const { plan } = await service.getHizaliVtt(room, tur.subId, eng.subId);
  assert.equal(plan.ok, true);
  assert.equal(plan.mod, 'parcali');
  assert.ok(plan.noktalar.length > 1);
  assert.ok(plan.guven > 0.9, `güven ${plan.guven}`);
});

test('alakasız altyazı hizalanmaz, dosya olduğu gibi döner', async () => {
  const { ref } = altyaziCifti(0);
  const { hedef } = altyaziCifti(0, { kirilmaSn: 0, kirilmaEk: 0 });
  // Bambaşka bir ritim: her replik tam 3 saniyede bir.
  const baska = ['WEBVTT', ''];
  for (let i = 0; i < 200; i += 1) baska.push(`${new Date(i * 3000).toISOString().slice(11, 23)} --> ${new Date(i * 3000 + 1000).toISOString().slice(11, 23)}`, 'x', '');
  const { room, service } = hizaServisi({ 'https://os/eng.srt': ref, 'https://os/tur.srt': baska.join('\n') });
  await service.refresh(room, () => {});
  const eng = room.subtitles.find((s) => s.lang === 'eng' && s.source === 'addon');
  const tur = room.subtitles.find((s) => s.lang === 'tur' && s.source === 'addon');
  const { vtt, plan } = await service.getHizaliVtt(room, tur.subId, eng.subId);
  assert.equal(plan.ok, false);
  assert.equal(plan.sebep, 'oturmadi');
  assert.equal(vtt, baska.join('\n'), 'oturmayan plan uygulanmıyor');
  assert.ok(hedef.length > 0);
});

test('ref verilmezse ya da aynı altyazıysa hizalama yapılmaz', async () => {
  const { ref, hedef } = altyaziCifti(4);
  const { room, service } = hizaServisi({ 'https://os/eng.srt': ref, 'https://os/tur.srt': hedef });
  await service.refresh(room, () => {});
  const tur = room.subtitles.find((s) => s.lang === 'tur' && s.source === 'addon');
  assert.equal((await service.getHizaliVtt(room, tur.subId, null)).plan, null);
  assert.equal((await service.getHizaliVtt(room, tur.subId, tur.subId)).plan, null);
  assert.equal((await service.getHizaliVtt(room, 'yok', tur.subId)).vtt, null);
});

test('uçlar: ?ref ile hizalanmış vtt ve hiza.json', async () => {
  const { ref, hedef } = altyaziCifti(5.25);
  const { room, service } = hizaServisi({ 'https://os/eng.srt': ref, 'https://os/tur.srt': hedef });
  await service.refresh(room, () => {});
  const eng = room.subtitles.find((s) => s.lang === 'eng' && s.source === 'addon');
  const tur = room.subtitles.find((s) => s.lang === 'tur' && s.source === 'addon');

  const app = express();
  app.use(createSubtitleRouter({
    rooms: { get: (id) => (id === room.id ? room : undefined) },
    service,
    dispatch: () => {},
    log: silentLog,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ilk = (metin) => metin.match(/(\d{2}:\d{2}:\d{2}\.\d{3}) -->/)[1];
    // ref'siz: dosya olduğu gibi (kaydırılmış hâli)
    const ham = await (await fetch(`${base}/sub/${room.id}/${tur.subId}.vtt`)).text();
    assert.notEqual(ilk(ham), ilk(ref));
    // ref ile: birinciyle aynı ana gelmiş
    const res = await fetch(`${base}/sub/${room.id}/${tur.subId}.vtt?ref=${eng.subId}`);
    assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.equal(ilk(await res.text()), ilk(ref));

    const hiza = await (await fetch(`${base}/sub/${room.id}/${tur.subId}/hiza.json?ref=${eng.subId}`)).json();
    assert.equal(hiza.ok, true);
    assert.equal(hiza.mod, 'sabit');
    assert.equal(hiza.kesin, true);
    assert.ok(Math.abs(hiza.kaydirma + 5.25) < 0.1, `kaydırma ${hiza.kaydirma}`);

    // ref zorunlu, bilinmeyen oda 404
    assert.equal((await fetch(`${base}/sub/${room.id}/${tur.subId}/hiza.json`)).status, 400);
    assert.equal((await fetch(`${base}/sub/NOROOM/${tur.subId}/hiza.json?ref=x`)).status, 404);
  } finally {
    server.close();
  }
});
