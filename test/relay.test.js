import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createRelay } from '../src/relay.js';
import { hlsConvertId, hlsV2Query } from '../public/js/shared/stream-url.js';
import { createRoomManager } from '../src/rooms.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const IH = 'd'.repeat(40);
const STREAMS = [
  { streamId: 's1', kind: 'torrent', infoHash: IH, fileIdx: 2, sources: ['tracker:udp://t:1'], addonName: 'T' },
  { streamId: 's2', kind: 'http', url: 'https://rd/x', addonName: 'RD' },
];
const silentLog = { info() {}, warn() {}, error() {} };

let stremio;
let seen = [];
let app;
let server;
let base;
let rooms;
let relay;

before(async () => {
  stremio = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range });
    if (req.url.includes('/master.m3u8')) {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      return res.end(`#EXTM3U\nhttp://127.0.0.1:${stremio.address().port}/hlsv2/abc/video0.m3u8?x=1\naudio0.m3u8?x=1\n`);
    }
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/100', 'accept-ranges': 'bytes' });
    res.end('abcd');
  });
  await new Promise((r) => stremio.listen(0, '127.0.0.1', r));
  rooms = createRoomManager();
  relay = createRelay({ rooms, stremioBase: `http://127.0.0.1:${stremio.address().port}`, log: silentLog });
  app = express();
  app.use(relay.router);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  relay.stop();
  server.close();
  stremio.close();
});

function setup(settings = {}) {
  const { room, creatorToken } = rooms.create({
    type: 'movie', contentId: 'tt1', meta: {}, streams: STREAMS, hostStreamId: 's1',
    settings: { ...DEFAULT_CONFIG.defaults, relayEnabled: true, relayLimit: 1, ...settings },
  });
  const host = room.join({ token: creatorToken, name: 'H', socketId: 'h' }).user;
  const a = room.join({ token: 'guest-a-token', name: 'A', socketId: 'a' }).user;
  const b = room.join({ token: 'guest-b-token', name: 'B', socketId: 'b' }).user;
  return { room, host, a, b };
}

test('relay limit, host exemption and disabled relay', () => {
  const { room, host, a, b } = setup();
  const ka = room.requestRelay(a.id);
  assert.match(ka.reply.relayKey, /^[0-9a-f]{32}$/);
  assert.deepEqual(room.requestRelay(b.id), { error: 'relayFull' });
  assert.ok(room.requestRelay(host.id).reply.relayKey, 'host does not count');
  assert.equal(room.requestRelay(a.id).reply.relayKey, ka.reply.relayKey, 'idempotent');

  const res = room.updateSettings(host.id, { relayEnabled: false });
  assert.ok(res.msgs.some((m) => m.event === 'relayRevoked' && m.to === a.id));
  assert.equal(room.users.get(a.id).relayKey, null);
  assert.ok(room.users.get(host.id).relayKey, 'host keeps local relay');
  assert.deepEqual(room.requestRelay(b.id), { error: 'relayOff' });
});

test('lowering the limit revokes the newest grants', () => {
  const { room, host, a, b } = setup({ relayLimit: 2 });
  room.requestRelay(a.id);
  room.requestRelay(b.id);
  room.updateSettings(host.id, { relayLimit: 1 });
  assert.ok(room.users.get(a.id).relayKey);
  assert.equal(room.users.get(b.id).relayKey, null);
});

test('valid request is proxied with trackers and range', async () => {
  const { room, a } = setup();
  const key = room.requestRelay(a.id).reply.relayKey;
  seen = [];
  const res = await fetch(`${base}/relay/${room.id}/${key}/${IH}/2`, { headers: { range: 'bytes=0-3' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 0-3/100');
  assert.equal(await res.text(), 'abcd');
  assert.equal(seen[0].url, `/${IH}/2?tr=${encodeURIComponent('tracker:udp://t:1')}`);
  assert.equal(seen[0].range, 'bytes=0-3');
  assert.ok(relay.stats(room.id).users[0].bytes >= 4);
});

test('forbidden requests never reach Stremio', async () => {
  const { room, a } = setup();
  const key = room.requestRelay(a.id).reply.relayKey;
  seen = [];
  const codes = await Promise.all([
    fetch(`${base}/relay/${room.id}/wrongkey/${IH}/2`).then((r) => r.status),
    fetch(`${base}/relay/${room.id}/${key}/${'e'.repeat(40)}/2`).then((r) => r.status),
    fetch(`${base}/relay/${room.id}/${key}/${IH}/3`).then((r) => r.status),
    fetch(`${base}/relay/${room.id}/${key}/${IH}/2/settings`).then((r) => r.status),
    fetch(`${base}/relay/${room.id}/${key}/${IH}/2/..%2F..%2Fsettings`).then((r) => r.status),
    fetch(`${base}/relay/NOROOM/${key}/${IH}/2`).then((r) => r.status),
  ]);
  assert.deepEqual(codes, [403, 403, 403, 404, 404, 404]);
  assert.equal(seen.length, 0);
});

const CAPS = { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'mp3'] };
const stremioBase = () => `http://127.0.0.1:${stremio.address().port}`;
const hlsUrl = (room, key, tail, { stream = STREAMS[0], caps = CAPS, id, extra = '' } = {}) =>
  `${base}/relay/${room.id}/${key}/hlsv2/${id ?? hlsConvertId(stream, caps)}/${tail}?${hlsV2Query(stream, caps, stremioBase())}${extra}`;

test('hlsv2 converter requests for room torrents are proxied; playlists rewritten', async () => {
  const { room, a } = setup();
  const key = room.requestRelay(a.id).reply.relayKey;
  seen = [];
  const res = await fetch(hlsUrl(room, key, 'master.m3u8'));
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, new RegExp(`^/relay/${room.id}/${key}/hlsv2/abc/video0\\.m3u8\\?x=1$`, 'm'));
  assert.match(text, /^audio0\.m3u8\?x=1$/m);
  const forwarded = seen.find((s) => s.url.includes('/master.m3u8')).url;
  assert.ok(forwarded.startsWith(`/hlsv2/${hlsConvertId(STREAMS[0], CAPS)}/master.m3u8?mediaURL=`));
  assert.ok(forwarded.includes('videoCodecs=hevc'));
  const seg = await fetch(hlsUrl(room, key, 'video0/segment12.m4s'));
  assert.equal(seg.status, 206);
});

test('hlsv2 requests that do not match a room torrent never reach Stremio', async () => {
  const { room, a } = setup();
  const key = room.requestRelay(a.id).reply.relayKey;
  const other = { streamId: 'x', kind: 'torrent', infoHash: 'e'.repeat(40), fileIdx: 2, sources: [] };
  seen = [];
  const codes = await Promise.all([
    hlsUrl(room, key, 'master.m3u8', { id: 'stremio-app-converter' }), // someone else's converter
    hlsUrl(room, key, 'master.m3u8', { id: hlsConvertId(STREAMS[0], { videoCodecs: ['h264'], audioCodecs: ['aac'] }) }),
    hlsUrl(room, key, 'master.m3u8', { stream: other }), // torrent not in the room
    hlsUrl(room, key, 'master.m3u8', { extra: '&forceTranscoding=1' }), // unknown parameter
    hlsUrl(room, key, 'master.m3u8', { caps: { videoCodecs: ['h264', 'prores'], audioCodecs: ['aac'] } }),
    hlsUrl(room, key, 'destroy'),
    hlsUrl(room, key, '..%2F..%2Fsettings'),
    `${base}/relay/${room.id}/${key}/hlsv2/abc/master.m3u8?mediaURL=${encodeURIComponent('file:///C:/secret.mkv')}&videoCodecs=h264&audioCodecs=aac`,
    `${base}/relay/${room.id}/${key}/${IH}/2/hls.m3u8`, // old converter path is gone
  ].map((u) => fetch(u).then((r) => r.status)));
  assert.deepEqual(codes, [403, 403, 403, 403, 403, 403, 403, 403, 404]);
  assert.equal(seen.length, 0);
});

test('revoked key stops working', async () => {
  const { room, a } = setup();
  const key = room.requestRelay(a.id).reply.relayKey;
  room.releaseRelay(a.id);
  assert.equal((await fetch(`${base}/relay/${room.id}/${key}/${IH}/2`)).status, 403);
});
