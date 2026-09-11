import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { extractTunnelUrl, findCloudflared, createTunnel } from '../src/tunnel.js';

const silentLog = { info() {}, warn() {}, error() {} };

test('extractTunnelUrl finds the quick tunnel url in cloudflared output', () => {
  const line = '2026-09-11T10:00:00Z INF |  https://brave-owl-seven-cats.trycloudflare.com                        |';
  assert.equal(extractTunnelUrl(line), 'https://brave-owl-seven-cats.trycloudflare.com');
  assert.equal(extractTunnelUrl('INF Starting tunnel'), null);
  assert.equal(extractTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": EOF'), null);
});

test('findCloudflared searches PATH then known install folders', () => {
  const dir = path.join('C:', 'tools');
  const found = findCloudflared({
    env: { PATH: `C:\\nothing${path.delimiter}${dir}` },
    exists: (p) => p === path.join(dir, 'cloudflared.exe'),
  });
  assert.equal(found, path.join(dir, 'cloudflared.exe'));
  const known = findCloudflared({
    env: { PATH: '' },
    exists: (p) => p === 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  });
  assert.equal(known, 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe');
  assert.equal(findCloudflared({ env: {}, exists: () => false }), null);
});

function fakeSpawn() {
  const children = [];
  const spawn = (bin, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.args = args;
    child.kill = () => child.emit('exit', 1);
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test('tunnel reports missing when cloudflared is not installed', () => {
  const t = createTunnel({ port: 7000, log: silentLog, find: () => null, spawn: fakeSpawn().spawn });
  t.start();
  assert.deepEqual(t.status(), { state: 'missing', url: null });
});

test('tunnel goes up with the url, restarts after exit, stops cleanly', async () => {
  const { spawn, children } = fakeSpawn();
  const changes = [];
  const t = createTunnel({
    port: 7000,
    log: silentLog,
    find: () => 'cloudflared',
    spawn,
    backoffMs: [10],
    onChange: (s) => changes.push(s),
  });
  t.start();
  assert.equal(t.status().state, 'starting');
  assert.deepEqual(children[0].args, ['tunnel', '--url', 'http://127.0.0.1:7000', '--no-autoupdate']);

  children[0].stderr.emit('data', Buffer.from('INF |  https://a-b.trycloudflare.com  |\n'));
  assert.deepEqual(t.status(), { state: 'up', url: 'https://a-b.trycloudflare.com' });

  children[0].emit('exit', 1);
  assert.deepEqual(t.status(), { state: 'down', url: null });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(children.length, 2, 'restarted after backoff');

  t.stop();
  assert.equal(t.status().state, 'stopped');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(children.length, 2, 'no restart after stop');
  assert.ok(changes.some((c) => c.state === 'up'));
});

test('restart kills the current process and starts a new one', () => {
  const { spawn, children } = fakeSpawn();
  const t = createTunnel({ port: 7000, log: silentLog, find: () => 'cloudflared', spawn, backoffMs: [10_000] });
  t.start();
  t.restart();
  assert.equal(children.length, 2);
  assert.equal(t.status().state, 'starting');
  t.stop();
});
