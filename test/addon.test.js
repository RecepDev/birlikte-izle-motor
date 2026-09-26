import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAddonRouter, MANIFEST, isContentId } from '../src/addon.js';

async function withServer(fn) {
  const app = express();
  app.use(createAddonRouter({ panelBase: 'http://127.0.0.1:7001' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test('isContentId accepts movie and episode ids', () => {
  assert.equal(isContentId('tt0111161'), true);
  assert.equal(isContentId('tt0898266:1:12'), true);
  assert.equal(isContentId('kitsu:1'), false);
  assert.equal(isContentId('tt1/../x'), false);
});

test('manifest is served with CORS', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/manifest.json`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual(await res.json(), MANIFEST);
  });
});

test('stream handler returns a desktop link and a browser link', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/stream/series/tt0898266:1:12.json`);
    const body = await res.json();
    assert.equal(body.streams.length, 2);
    const panel = 'http://127.0.0.1:7001/new?type=series&id=tt0898266%3A1%3A12';
    assert.equal(body.streams[0].externalUrl, `birlikteizle://${encodeURIComponent(panel)}`);
    assert.equal(body.streams[1].externalUrl, panel);
  });
});

test('stream handler rejects unknown types and ids with an empty list', async () => {
  await withServer(async (base) => {
    assert.deepEqual(await (await fetch(`${base}/stream/tv/tt1.json`)).json(), { streams: [] });
    assert.deepEqual(await (await fetch(`${base}/stream/movie/kitsu:1.json`)).json(), { streams: [] });
  });
});

test('configure redirects to the panel', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/configure`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'http://127.0.0.1:7001/');
  });
});
