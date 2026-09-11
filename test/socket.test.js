import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import { attachSocket } from '../src/socket.js';
import { createRoomManager } from '../src/rooms.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const STREAMS = [{ streamId: 's1', kind: 'torrent', infoHash: 'a'.repeat(40), fileIdx: 0, addonName: 'T' }];
const silentLog = { info() {}, warn() {}, error() {} };

let server;
let io;
let ctl;
let rooms;
let url;
const clients = [];

before(async () => {
  server = http.createServer();
  io = new Server(server);
  rooms = createRoomManager();
  ctl = attachSocket(io, {
    rooms,
    log: silentLog,
    getPublicUrl: () => 'https://tunnel.example',
    usersThrottleMs: 20,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const c of clients) c.close();
  ctl.stop();
  io.close();
  server.close();
});

function connect() {
  const c = ioc(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(c);
  return c;
}

const emit = (c, event, payload) => new Promise((r) => c.emit(event, payload, r));
const once = (c, event, pred = () => true, ms = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const handler = (data) => {
      if (!pred(data)) return;
      clearTimeout(timer);
      c.off(event, handler);
      resolve(data);
    };
    c.on(event, handler);
  });

function newRoom(settings = {}) {
  return rooms.create({
    type: 'movie', contentId: 'tt1', meta: { name: 'Film' }, streams: STREAMS, hostStreamId: 's1',
    settings: { ...DEFAULT_CONFIG.defaults, ...settings },
  });
}

async function joinPair(settings) {
  const { room, creatorToken } = newRoom(settings);
  const a = connect();
  const b = connect();
  const ja = await emit(a, 'join', { roomId: room.id, userToken: creatorToken, name: 'Host' });
  const jb = await emit(b, 'join', { roomId: room.id, userToken: 'guest-token-1234', name: 'Ali' });
  return { room, a, b, ja, jb };
}

test('join returns snapshot and public url; unknown room is rejected', async () => {
  const { ja, jb } = await joinPair();
  assert.equal(ja.ok, true);
  assert.equal(ja.snapshot.hostUserId, ja.snapshot.you);
  assert.equal(ja.publicUrl, 'https://tunnel.example');
  assert.notEqual(jb.snapshot.you, ja.snapshot.you);

  const c = connect();
  assert.deepEqual(await emit(c, 'join', { roomId: 'NOPE00', userToken: 'xxxxxxxxxx', name: 'x' }), { error: 'notFound' });
});

test('locked room: guest control rejected, host control broadcast', async () => {
  const { a, b } = await joinPair({ locked: true, waitMode: 'continue' });
  assert.deepEqual(await emit(b, 'control', { action: 'play', position: 0 }), { error: 'locked' });
  const got = once(b, 'playback');
  assert.deepEqual(await emit(a, 'control', { action: 'play', position: 12 }), { ok: true });
  const pb = await got;
  assert.equal(pb.playback.paused, false);
  assert.equal(pb.playback.position, 12);
  assert.equal(pb.by, 'Host');
});

test('chat is delivered to everyone', async () => {
  const { a, b } = await joinPair();
  const got = once(a, 'chat', (m) => !m.system);
  await emit(b, 'chat', { text: 'selam' });
  const msg = await got;
  assert.equal(msg.text, 'selam');
  assert.equal(msg.from, 'Ali');
});

test('wait mode flow over sockets', async () => {
  const { a, b, jb } = await joinPair({ waitMode: 'wait' });
  await emit(a, 'status', { state: 'ready', source: 'local' });
  await emit(b, 'status', { state: 'loading', source: 'local' });
  const waiting = once(a, 'waiting', (w) => w.userIds.length === 1);
  await emit(a, 'control', { action: 'play', position: 0 });
  assert.deepEqual((await waiting).userIds, [jb.snapshot.you]);

  const started = once(a, 'playback', (p) => !p.playback.paused);
  await emit(b, 'status', { state: 'ready', source: 'local' });
  await started;
});

test('users updates are throttled but delivered', async () => {
  const { a, b } = await joinPair();
  const got = once(a, 'users', (d) => d.users.some((u) => u.status.drift === 0.4));
  await emit(b, 'status', { state: 'idle', source: 'none', drift: 0.4 });
  await got;
});

test('time returns server clock', async () => {
  const c = connect();
  const t = await emit(c, 'time');
  assert.ok(Math.abs(t - Date.now()) < 1000);
});

test('room events require join', async () => {
  const c = connect();
  assert.deepEqual(await emit(c, 'chat', { text: 'x' }), { error: 'notJoined' });
});

test('per-socket rate limit', async () => {
  const c = connect();
  const replies = await Promise.all(Array.from({ length: 30 }, () => emit(c, 'time')));
  assert.ok(replies.some((r) => r?.error === 'rate'));
});

test('same token in a new tab replaces the old socket', async () => {
  const { room, b } = await joinPair();
  const replaced = once(b, 'replaced');
  const c = connect();
  const res = await emit(c, 'join', { roomId: room.id, userToken: 'guest-token-1234', name: 'Ali' });
  assert.equal(res.ok, true);
  await replaced;
});

test('panel kick disconnects the user and bans the token', async () => {
  const { room, b, jb } = await joinPair();
  const gone = once(b, 'disconnect');
  assert.equal(ctl.kickUser(room.id, jb.snapshot.you), true);
  await gone;
  const again = connect();
  assert.deepEqual(
    await emit(again, 'join', { roomId: room.id, userToken: 'guest-token-1234', name: 'Ali' }),
    { error: 'banned' },
  );
});

test('closeRoom notifies everyone and removes the room', async () => {
  const { room, a } = await joinPair();
  const closed = once(a, 'roomClosed');
  assert.equal(ctl.closeRoom(room.id), true);
  await closed;
  assert.equal(rooms.get(room.id), undefined);
});

test('broadcastPublicUrl reaches joined clients', async () => {
  const { a } = await joinPair();
  const got = once(a, 'publicUrl');
  ctl.broadcastPublicUrl('https://new.example');
  assert.equal(await got, 'https://new.example');
});
