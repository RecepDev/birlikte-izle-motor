import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuality,
  parseSizeBytes,
  parseVideoRisk,
  normalizeStreams,
  guestStreamList,
} from '../src/streams.js';

const IH = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';

test('parseQuality finds common labels', () => {
  assert.equal(parseQuality('Torrentio\n4k HDR'), '2160p');
  assert.equal(parseQuality('Movie.2024.2160p.WEB'), '2160p');
  assert.equal(parseQuality('Movie 1080p x265'), '1080p');
  assert.equal(parseQuality('720p'), '720p');
  assert.equal(parseQuality('480p'), '480p');
  assert.equal(parseQuality('CAM'), null);
});

test('parseVideoRisk flags formats browsers often cannot decode', () => {
  assert.equal(parseVideoRisk('Movie.2160p.DV.HDR.x265'), 'Dolby Vision');
  assert.equal(parseVideoRisk('Movie 1080p HEVC 10bit'), 'HEVC');
  assert.equal(parseVideoRisk('Movie.1080p.x.265'), 'HEVC');
  assert.equal(parseVideoRisk('Movie 1080p AV1'), 'AV1');
  assert.equal(parseVideoRisk('Movie.1080p.x264'), null);
  assert.equal(parseVideoRisk('Divx release'), null);
});

test('parseSizeBytes prefers behaviorHints.videoSize then title', () => {
  assert.equal(parseSizeBytes({ behaviorHints: { videoSize: 1234 }, title: '💾 9 GB' }), 1234);
  assert.equal(parseSizeBytes({ title: 'x\n👤 12 💾 2.5 GB ⚙️ yts' }), 2.5 * 1024 ** 3);
  assert.equal(parseSizeBytes({ title: 'size 700 MB' }), 700 * 1024 ** 2);
  assert.equal(parseSizeBytes({ title: 'no size' }), null);
});

test('normalizeStreams keeps torrent and http, drops others', () => {
  const out = normalizeStreams([
    {
      addonName: 'Torrentio',
      streams: [
        { name: 'Torrentio\n1080p', title: 'Movie.1080p\n💾 2 GB', infoHash: IH, fileIdx: 1, sources: ['tracker:udp://t:1', 'bad'] },
        { name: 'RD 4k', title: 'Movie.2160p', url: 'https://rd.example/file.mkv', behaviorHints: { notWebReady: true } },
        { name: 'yt', ytId: 'abc' },
        { name: 'ext', externalUrl: 'https://x' },
        { name: 'hdr', url: 'https://h.example/v.mp4', behaviorHints: { proxyHeaders: { request: { a: 'b' } } } },
      ],
    },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    streamId: 's1',
    kind: 'torrent',
    addonName: 'Torrentio',
    name: 'Torrentio\n1080p',
    title: 'Movie.1080p\n💾 2 GB',
    quality: '1080p',
    videoRisk: null,
    sizeBytes: 2 * 1024 ** 3,
    infoHash: IH.toLowerCase(),
    fileIdx: 1,
    sources: ['tracker:udp://t:1'],
    url: null,
    notWebReady: false,
    subtitles: [],
  });
  assert.equal(out[1].kind, 'http');
  assert.equal(out[1].url, 'https://rd.example/file.mkv');
  assert.equal(out[1].notWebReady, true);
  assert.equal(out[1].quality, '2160p');
  assert.equal(out[1].streamId, 's2');
});

test('normalizeStreams rejects malformed infoHash and keeps stream subtitles', () => {
  const out = normalizeStreams([
    {
      addonName: 'A',
      streams: [
        { infoHash: 'nothex', name: 'x' },
        { infoHash: IH, subtitles: [{ id: '1', url: 'https://s/1.srt', lang: 'tur' }, { url: 42 }] },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].fileIdx, null);
  assert.deepEqual(out[0].subtitles, [{ id: '1', url: 'https://s/1.srt', lang: 'tur' }]);
});

test('guestStreamList hides http streams except the host one', () => {
  const streams = normalizeStreams([
    {
      addonName: 'A',
      streams: [
        { infoHash: IH },
        { url: 'https://secret.example/key1/a.mkv' },
        { url: 'https://secret.example/key1/b.mkv' },
      ],
    },
  ]);
  assert.deepEqual(guestStreamList(streams, 's1').map((s) => s.streamId), ['s1']);
  assert.deepEqual(guestStreamList(streams, 's3').map((s) => s.streamId), ['s1', 's3']);
});
