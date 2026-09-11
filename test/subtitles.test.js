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
