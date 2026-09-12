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

const STREAM = { kind: 'torrent', infoHash: 'a'.repeat(40), fileIdx: 0, sources: [] };

test('checkTorrent reports alive once real download speed shows up', async () => {
  let statsHits = 0;
  const s = await fakeStremio((req, res) => {
    if (req.url.endsWith('/stats.json')) {
      statsHits += 1;
      res.end(JSON.stringify({ peers: 3, downloadSpeed: statsHits < 2 ? 0 : 500_000, streamProgress: 0.1 }));
      return;
    }
    res.end('ok'); // the warm-up range request against the media path
  });
  const local = createStremioLocal({ base: s.base, timeoutMs: 1000 });
  const result = await local.checkTorrent(STREAM, { checkMs: 5000, pollMs: 10 });
  assert.equal(result.alive, true);
  assert.ok(result.downMbps > 0);
  assert.equal(result.peers, 3);
  s.close();
});

test('checkTorrent reports not alive when the torrent never actually downloads', async () => {
  const s = await fakeStremio((req, res) => {
    if (req.url.endsWith('/stats.json')) {
      res.end(JSON.stringify({ peers: 5, downloadSpeed: 0, streamProgress: 0 }));
      return;
    }
    res.end('ok');
  });
  const local = createStremioLocal({ base: s.base, timeoutMs: 1000 });
  const result = await local.checkTorrent(STREAM, { checkMs: 60, pollMs: 10 });
  assert.equal(result.alive, false);
  assert.equal(result.downMbps, 0);
  assert.equal(result.peers, 5);
  s.close();
});

test('checkTorrent reports alive for a file already fully cached on disk (nothing left to download)', async () => {
  const s = await fakeStremio((req, res) => {
    if (req.url.endsWith('/stats.json')) {
      // Already on disk from a previous run: no download speed needed, streamProgress is maxed out.
      res.end(JSON.stringify({ peers: 0, downloadSpeed: 0, streamProgress: 1 }));
      return;
    }
    res.end('ok');
  });
  const local = createStremioLocal({ base: s.base, timeoutMs: 1000 });
  const result = await local.checkTorrent(STREAM, { checkMs: 5000, pollMs: 10 });
  assert.equal(result.alive, true);
  assert.equal(result.downMbps, 0);
  s.close();
});
