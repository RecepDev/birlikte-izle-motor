import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAddonsClient, addonBase } from '../src/addons-client.js';

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (r === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  fn.calls = calls;
  return fn;
}

const TORRENTIO = { url: 'https://torrentio.example/opts/manifest.json', name: 'Torrentio', enabled: true, resources: ['stream'] };
const SUBS = { url: 'https://subs.example/manifest.json', name: 'Subs', enabled: true, resources: ['subtitles'] };
const OFF = { url: 'https://off.example/manifest.json', name: 'Off', enabled: false, resources: ['stream'] };

test('addonBase strips manifest.json', () => {
  assert.equal(addonBase('https://a.b/x/manifest.json'), 'https://a.b/x');
});

test('manifest summarizes name and supported resources', async () => {
  const fetchImpl = fakeFetch({
    'https://torrentio.example/opts/manifest.json': {
      name: 'Torrentio', resources: ['stream', { name: 'subtitles', types: ['movie'] }, 'catalog'], types: ['movie'],
    },
  });
  const client = createAddonsClient({ fetchImpl });
  assert.deepEqual(await client.manifest(TORRENTIO.url), { name: 'Torrentio', resources: ['stream', 'subtitles'] });
});

test('manifest throws a readable error on failure', async () => {
  const client = createAddonsClient({ fetchImpl: fakeFetch({}) });
  await assert.rejects(client.manifest('https://x/manifest.json'), /HTTP 404/);
});

test('streams calls enabled stream addons only and reports errors per addon', async () => {
  const broken = { ...TORRENTIO, url: 'https://broken.example/manifest.json', name: 'Broken' };
  const slow = { ...TORRENTIO, url: 'https://slow.example/manifest.json', name: 'Slow' };
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const fetchImpl = fakeFetch({
    'https://torrentio.example/opts/stream/series/tt1:1:2.json': { streams: [{ infoHash: 'a'.repeat(40) }] },
    'https://slow.example/stream/series/tt1:1:2.json': timeout,
  });
  const client = createAddonsClient({ fetchImpl });
  const res = await client.streams([TORRENTIO, SUBS, OFF, broken, slow], 'series', 'tt1:1:2');
  assert.deepEqual(res.results, [{ addonName: 'Torrentio', streams: [{ infoHash: 'a'.repeat(40) }] }]);
  assert.deepEqual(res.errors, [
    { addonName: 'Broken', message: 'HTTP 404' },
    { addonName: 'Slow', message: 'zaman aşımı' },
  ]);
  assert.equal(fetchImpl.calls.some((u) => u.includes('subs.example') || u.includes('off.example')), false);
});

test('addons without known resources are tried for both', async () => {
  const unknown = { url: 'https://u.example/manifest.json', name: 'U', enabled: true, resources: [] };
  const fetchImpl = fakeFetch({ 'https://u.example/stream/movie/tt9.json': { streams: [] } });
  const client = createAddonsClient({ fetchImpl });
  const res = await client.streams([unknown], 'movie', 'tt9');
  assert.deepEqual(res.results, [{ addonName: 'U', streams: [] }]);
});

test('subtitles passes video hash as extra and tags addon name', async () => {
  const fetchImpl = fakeFetch({
    'https://subs.example/subtitles/movie/tt9/videoHash=abc&videoSize=100.json': {
      subtitles: [{ id: '1', url: 'https://s/1.srt', lang: 'tur' }, { id: 'bad' }],
    },
    'https://subs.example/subtitles/movie/tt9.json': { subtitles: [{ id: '2', url: 'https://s/2.srt', lang: 'eng' }] },
  });
  const client = createAddonsClient({ fetchImpl });
  const withHash = await client.subtitles([SUBS, TORRENTIO], 'movie', 'tt9', { hash: 'abc', size: 100 });
  assert.deepEqual(withHash.subtitles, [{ id: '1', url: 'https://s/1.srt', lang: 'tur', addonName: 'Subs' }]);
  const plain = await client.subtitles([SUBS], 'movie', 'tt9');
  assert.equal(plain.subtitles[0].id, '2');
});

test('meta reads Cinemeta, adds episode label for series', async () => {
  const fetchImpl = fakeFetch({
    'https://v3-cinemeta.strem.io/meta/movie/tt1.json': { meta: { name: 'Dune', poster: 'https://p/1.jpg' } },
    'https://v3-cinemeta.strem.io/meta/series/tt2.json': {
      meta: { name: 'Dark', poster: null, videos: [{ season: 1, episode: 2, name: 'Lies' }] },
    },
  });
  const client = createAddonsClient({ fetchImpl });
  assert.deepEqual(await client.meta('movie', 'tt1'), { name: 'Dune', poster: 'https://p/1.jpg' });
  assert.deepEqual(await client.meta('series', 'tt2:1:2'), { name: 'Dark S01E02 · Lies', poster: null });
});

test('meta falls back to the id on failure', async () => {
  const client = createAddonsClient({ fetchImpl: fakeFetch({}) });
  assert.deepEqual(await client.meta('movie', 'tt404'), { name: 'tt404', poster: null });
});
