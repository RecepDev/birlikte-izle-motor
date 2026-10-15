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
let metaCagrisi = 0;
let base;
let rooms;
let config;
const socketCalls = [];

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-panel-'));
  fs.writeFileSync(path.join(dir, 'uygulama.html'), '<meta name="panel-key" content="%%PANEL_KEY%%">panel');
  fs.writeFileSync(path.join(dir, 'new.html'), '<meta name="panel-key" content="%%PANEL_KEY%%">new');
  rooms = createRoomManager();
  config = createConfigStore(path.join(dir, 'config.json'));
  // Named to match the fake addons.streams() below, so the retry tests can
  // filter `enabled` by name the same way the real client/panel-api do.
  config.save({
    nickname: 'Host',
    addons: [
      { url: 'https://t.example/manifest.json', name: 'T', enabled: true, resources: ['stream'] },
      { url: 'https://slow.example/manifest.json', name: 'Slow', enabled: true, resources: ['stream'] },
    ],
    defaults: { locked: true, waitMode: 'wait', relayEnabled: true, relayLimit: 2, relay4k: false },
  });
  const app = createPanelApp({
    panelKey: KEY,
    panelDir: dir,
    publicBase: 'http://127.0.0.1:7000',
    config,
    addons: {
      manifest: async (url) => {
        if (url.includes('bad')) throw new Error('HTTP 404');
        return { name: 'Torrentio', resources: ['stream'] };
      },
      meta: async () => { metaCagrisi += 1; return { name: 'Dune', poster: null }; },
      // Mirrors the real addons-client: only calls back for addons actually
      // present in `enabled`, so ?retry=Name filtering is meaningfully testable.
      streams: async (enabled, type, id, onAddon) => {
        const names = new Set(enabled.map((a) => a.name));
        const items = [{ infoHash: 'a'.repeat(40), name: '1080p' }, { url: 'https://rd/x' }];
        if (names.has('T')) onAddon?.('T', items, null);
        if (names.has('Slow')) onAddon?.('Slow', null, 'zaman aşımı');
        return {
          results: names.has('T') ? [{ addonName: 'T', streams: items }] : [],
          errors: names.has('Slow') ? [{ addonName: 'Slow', message: 'zaman aşımı' }] : [],
        };
      },
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

// /api/streams answers with one JSON object per line (NDJSON) so the panel
// can render addons as they reply; tests just want the merged final shape.
async function readStreams(res) {
  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = lines.find((l) => l.type === 'meta')?.meta;
  const streams = lines.filter((l) => l.type === 'addon').flatMap((l) => l.streams);
  const errors = lines.find((l) => l.type === 'done')?.errors || [];
  return { meta, streams, errors };
}

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
  const body = await readStreams(await api('/api/streams?type=movie&id=tt1'));
  assert.equal(body.meta.name, 'Dune');
  assert.deepEqual(body.streams.map((s) => s.kind), ['torrent', 'http']);
  assert.equal(body.errors[0].addonName, 'Slow');
});

test('?retry re-asks only the named addons and keeps the rest of the cached list', async () => {
  const first = await readStreams(await api('/api/streams?type=movie&id=tt2'));
  assert.deepEqual(first.streams.map((s) => s.name), ['1080p', '']); // T's torrent + http stream
  assert.equal(first.errors[0].addonName, 'Slow');

  // Retry only "Slow" — T must not be re-queried or duplicated in the merged list.
  const oncekiMetaCagrisi = metaCagrisi;
  const res = await api(`/api/streams?type=movie&id=tt2&retry=Slow`);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  const metaSatirlari = lines.filter((l) => l.type === 'meta');
  assert.equal(metaSatirlari.length, 1, 'the page still needs the title on a retry');
  assert.equal(metaSatirlari[0].meta.name, 'Dune');
  assert.equal(metaCagrisi, oncekiMetaCagrisi, 'meta comes from the cache, not a new fetch');
  const addonLines = lines.filter((l) => l.type === 'addon');
  assert.deepEqual(addonLines.map((l) => l.addonName), ['Slow'], "only the retried addon's line is sent");
  const done = lines.find((l) => l.type === 'done');
  assert.equal(done.errors[0].addonName, 'Slow'); // still fails the same way in this fake, but not duplicated

  // /api/rooms reuses the cache as-is (doesn't invalidate it the way a fresh
  // GET /api/streams does) — the best way to inspect what the retry left behind.
  const roomStreamId = first.streams.find((s) => s.name === '1080p').streamId;
  const created = await (await api('/api/rooms', { method: 'POST', body: { type: 'movie', id: 'tt2', streamId: roomStreamId } })).json();
  const room = rooms.get(created.roomId);
  assert.equal(room.streams.filter((s) => s.name === '1080p').length, 1, "T's stream wasn't duplicated by the retry");
  rooms.close(created.roomId); // just probing the cache via a room — don't leak it into later list()/order assertions
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
