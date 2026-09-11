import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createPanelApp } from '../src/panel-api.js';
import { createRoomManager } from '../src/rooms.js';
import { createConfigStore } from '../src/config.js';

const KEY = 'test-panel-key';
const silentLog = { info() {}, warn() {}, error() {}, recent: () => [{ msg: 'x' }] };

let server;
let base;
let rooms;
const socketCalls = [];

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-panel-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<meta name="panel-key" content="%%PANEL_KEY%%">panel');
  fs.writeFileSync(path.join(dir, 'new.html'), '<meta name="panel-key" content="%%PANEL_KEY%%">new');
  rooms = createRoomManager();
  const app = createPanelApp({
    panelKey: KEY,
    panelDir: dir,
    publicBase: 'http://127.0.0.1:7000',
    config: createConfigStore(path.join(dir, 'config.json')),
    addons: {
      manifest: async (url) => {
        if (url.includes('bad')) throw new Error('HTTP 404');
        return { name: 'Torrentio', resources: ['stream'] };
      },
      meta: async () => ({ name: 'Dune', poster: null }),
      streams: async () => ({
        results: [{ addonName: 'T', streams: [{ infoHash: 'a'.repeat(40), name: '1080p' }, { url: 'https://rd/x' }] }],
        errors: [{ addonName: 'Slow', message: 'zaman aşımı' }],
      }),
    },
    rooms,
    socketCtl: {
      closeRoom: (id) => { socketCalls.push(['close', id]); return rooms.close(id); },
      kickUser: (id, userId) => { socketCalls.push(['kick', id, userId]); return true; },
    },
    tunnel: { status: () => ({ state: 'up', url: 'https://t.example' }), restart() { socketCalls.push(['restart']); }, start() {} },
    stremioLocal: { isUp: async () => true },
    log: silentLog,
    onShutdown: () => socketCalls.push(['shutdown']),
    installCloudflared: async () => 0,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const api = (p, { method = 'GET', body, key = KEY, origin = base } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      ...(key ? { 'x-panel-key': key } : {}),
      ...(origin ? { origin } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

function rawGet(p, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('foreign Host header is rejected (DNS rebinding)', async () => {
  assert.equal(await rawGet('/api/ping', 'evil.example'), 403);
  assert.equal(await rawGet('/api/ping', `localhost:${server.address().port}`), 200);
});

test('ping needs no key, api needs key', async () => {
  assert.equal(await (await fetch(`${base}/api/ping`)).text(), 'ok');
  assert.equal((await api('/api/config', { key: null })).status, 401);
  assert.equal((await api('/api/config', { key: 'wrong' })).status, 401);
  assert.equal((await api('/api/config')).status, 200);
});

test('state-changing requests need the panel Origin', async () => {
  const cfg = await (await api('/api/config')).json();
  assert.equal((await api('/api/config', { method: 'PUT', body: cfg, origin: null })).status, 403);
  assert.equal((await api('/api/config', { method: 'PUT', body: cfg, origin: 'https://evil.example' })).status, 403);
  assert.equal((await api('/api/config', { method: 'PUT', body: { ...cfg, nickname: 'recep' } })).status, 200);
  assert.equal((await (await api('/api/config')).json()).nickname, 'recep');
});

test('invalid config is rejected with a message', async () => {
  const res = await api('/api/config', { method: 'PUT', body: { nickname: '' } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /nickname/);
});

test('pages get the panel key injected', async () => {
  assert.match(await (await fetch(`${base}/`)).text(), new RegExp(`content="${KEY}"`));
  assert.match(await (await fetch(`${base}/new?type=movie&id=tt1`)).text(), /new/);
});

test('addon test returns manifest summary or error', async () => {
  const ok = await api('/api/addons/test', { method: 'POST', body: { url: 'https://t/manifest.json' } });
  assert.deepEqual(await ok.json(), { name: 'Torrentio', resources: ['stream'] });
  const bad = await api('/api/addons/test', { method: 'POST', body: { url: 'https://bad/manifest.json' } });
  assert.equal(bad.status, 400);
});

test('status reports tunnel and stremio', async () => {
  const s = await (await api('/api/status')).json();
  assert.deepEqual(s.tunnel, { state: 'up', url: 'https://t.example' });
  assert.equal(s.stremio, true);
  assert.equal(s.addonUrl, 'http://127.0.0.1:7000/manifest.json');
});

test('streams validates ids and returns normalized list', async () => {
  assert.equal((await api('/api/streams?type=movie&id=../x')).status, 400);
  const body = await (await api('/api/streams?type=movie&id=tt1')).json();
  assert.equal(body.meta.name, 'Dune');
  assert.deepEqual(body.streams.map((s) => s.kind), ['torrent', 'http']);
  assert.equal(body.errors[0].addonName, 'Slow');
});

test('room create, list, kick, close', async () => {
  const created = await (await api('/api/rooms', { method: 'POST', body: { type: 'movie', id: 'tt1', streamId: 's1' } })).json();
  assert.match(created.roomId, /^[A-Z0-9]{6}$/);
  assert.equal(created.roomUrl, `http://127.0.0.1:7000/room/${created.roomId}#host=${created.creatorToken}&name=recep`);
  const room = rooms.get(created.roomId);
  assert.equal(room.meta.name, 'Dune');
  assert.equal(room.settings.waitMode, 'wait');

  const list = await (await api('/api/rooms')).json();
  assert.equal(list[0].id, created.roomId);

  assert.equal((await api(`/api/rooms/${created.roomId}/kick`, { method: 'POST', body: { userId: 'u1' } })).status, 200);
  assert.equal((await api(`/api/rooms/${created.roomId}/close`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/api/rooms/${created.roomId}/close`, { method: 'POST' })).status, 404);
  assert.deepEqual(socketCalls.filter((c) => c[0] !== 'restart').slice(0, 2), [
    ['kick', created.roomId, 'u1'],
    ['close', created.roomId],
  ]);
});

test('room create rejects unknown stream', async () => {
  const res = await api('/api/rooms', { method: 'POST', body: { type: 'movie', id: 'tt1', streamId: 's99' } });
  assert.equal(res.status, 400);
});

test('logs, tunnel restart and shutdown', async () => {
  assert.deepEqual(await (await api('/api/logs')).json(), [{ msg: 'x' }]);
  assert.equal((await api('/api/tunnel/restart', { method: 'POST' })).status, 200);
  assert.equal((await api('/api/shutdown', { method: 'POST' })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(socketCalls.some((c) => c[0] === 'shutdown'));
});
