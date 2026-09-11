import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStremioLocal } from '../src/stremio-local.js';

async function fakeStremio(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('isUp is true when /settings answers', async () => {
  const s = await fakeStremio((req, res) => res.end(req.url === '/settings' ? '{}' : ''));
  assert.equal(await createStremioLocal({ base: s.base }).isUp(), true);
  s.close();
});

test('isUp is false when nothing listens', async () => {
  assert.equal(await createStremioLocal({ base: 'http://127.0.0.1:1', timeoutMs: 500 }).isUp(), false);
});

test('opensubHash returns hash and size', async () => {
  let seen;
  const s = await fakeStremio((req, res) => {
    seen = req.url;
    res.end(JSON.stringify({ error: null, result: { hash: 'abc', size: 42 } }));
  });
  const local = createStremioLocal({ base: s.base });
  assert.deepEqual(await local.opensubHash('http://127.0.0.1:11470/x/0'), { hash: 'abc', size: 42 });
  assert.equal(seen, `/opensubHash?videoUrl=${encodeURIComponent('http://127.0.0.1:11470/x/0')}`);
  s.close();
});

test('opensubHash returns null on error', async () => {
  const s = await fakeStremio((req, res) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'nope', result: null }));
  });
  assert.equal(await createStremioLocal({ base: s.base }).opensubHash('x'), null);
  s.close();
});
