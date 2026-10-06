import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STREMIO_BASE,
  torrentPath,
  localTorrentUrl,
  hlsPath,
} from '../public/js/shared/stream-url.js';

const ih = 'a'.repeat(40);

test('torrentPath uses fileIdx or -1', () => {
  assert.equal(torrentPath({ infoHash: ih, fileIdx: 3 }), `/${ih}/3`);
  assert.equal(torrentPath({ infoHash: ih, fileIdx: null }), `/${ih}/-1`);
  assert.equal(torrentPath({ infoHash: ih }), `/${ih}/-1`);
});

test('localTorrentUrl adds only tracker/dht sources as tr params', () => {
  const url = localTorrentUrl({
    infoHash: ih,
    fileIdx: 0,
    sources: ['tracker:udp://tracker.example:1337/announce', `dht:${ih}`, 'http://evil'],
  });
  assert.equal(
    url,
    `${STREMIO_BASE}/${ih}/0?tr=${encodeURIComponent('tracker:udp://tracker.example:1337/announce')}&tr=${encodeURIComponent(`dht:${ih}`)}`,
  );
});

test('localTorrentUrl dosya adını f= olarak ekler (TorrServer motoru adla eşleştiriyor)', () => {
  assert.equal(
    localTorrentUrl({ infoHash: ih, fileIdx: 4, filename: 'Film 2160p.mkv' }, 'http://x'),
    `http://x/${ih}/4?f=Film%202160p.mkv`,
  );
});

test('localTorrentUrl without sources has no query', () => {
  assert.equal(localTorrentUrl({ infoHash: ih, fileIdx: 1 }, 'http://x'), `http://x/${ih}/1`);
});

test('hlsPath appends hls.m3u8', () => {
  assert.equal(hlsPath({ infoHash: ih, fileIdx: 2 }), `/${ih}/2/hls.m3u8`);
});
