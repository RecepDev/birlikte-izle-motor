import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, streamVerdict, pickBest } from '../public/js/compat.js';

const goodDevice = {
  videoCodecs: ['h264', 'hevc', 'av1'],
  audioCodecs: ['aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'],
  hevc4kSmooth: true,
  hdr10Decode: true,
  screenHdr: true,
  screenWidth: 3840,
  gpu: true,
  stremio: true,
  touch: false,
};

let n = 0;
const stream = (extra) => ({ streamId: `s${++n}`, kind: 'torrent', name: '', title: '', quality: '1080p', seeders: 10, ...extra });
const ids = (result) => result.problems.map((p) => p.id);

test('a capable device opening plain streams has nothing to report', () => {
  const r = evaluate({ device: goodDevice, streams: [stream({}), stream({ quality: '2160p', videoRisk: 'HEVC' })] });
  assert.equal(r.needsAttention, false);
  assert.deepEqual(r.problems, []);
  assert.equal(r.counts.direct, 2);
});

test('missing HEVC support is reported and such streams need a picture re-encode', () => {
  const device = { ...goodDevice, videoCodecs: ['h264'] };
  const hevc = stream({ quality: '2160p', videoRisk: 'HEVC' });
  const plain = stream({ quality: '720p' });
  const r = evaluate({ device, streams: [hevc, plain] });
  assert.ok(ids(r).includes('hevc'));
  assert.equal(r.problems[0].level, 'warn');
  assert.equal(r.counts.reencode, 1);
  assert.equal(r.best.streamId, plain.streamId);
});

test('HDR on a screen without HDR is a problem, but only when HDR streams exist', () => {
  const device = { ...goodDevice, screenHdr: false };
  assert.equal(evaluate({ device, streams: [stream({})] }).needsAttention, false);
  const r = evaluate({ device, streams: [stream({ hdr: 'HDR10+', videoRisk: 'HEVC' })] });
  assert.ok(ids(r).includes('hdr-screen'));
  assert.equal(r.hdrStreams, 1);
});

test('HDR10 that the browser cannot decode counts as a picture problem', () => {
  const device = { ...goodDevice, hdr10Decode: false };
  const s = stream({ hdr: 'HDR', videoRisk: 'HEVC' });
  assert.equal(streamVerdict(s, device).level, 'reencode');
  assert.ok(ids(evaluate({ device, streams: [s] })).includes('hdr-decode'));
});

test('Dolby Vision only warns when the stream being watched has no HDR10 layer', () => {
  const dvOnly = stream({ hdr: 'Dolby Vision', videoRisk: 'Dolby Vision', name: 'Movie DV' });
  const dvPlusHdr10 = stream({ hdr: 'Dolby Vision', videoRisk: 'Dolby Vision', name: 'Movie DV HDR10' });
  const watching = evaluate({ device: goodDevice, streams: [dvOnly, dvPlusHdr10], current: dvOnly });
  assert.equal(watching.problems.find((p) => p.id === 'dolby-vision').level, 'warn');
  const other = evaluate({ device: goodDevice, streams: [dvOnly, dvPlusHdr10], current: dvPlusHdr10 });
  assert.equal(other.problems.find((p) => p.id === 'dolby-vision').level, 'info');
  assert.equal(other.needsAttention, false);
});

test('missing hardware acceleration matters only when heavy streams exist', () => {
  const device = { ...goodDevice, gpu: false };
  assert.equal(evaluate({ device, streams: [stream({})] }).needsAttention, false);
  assert.ok(ids(evaluate({ device, streams: [stream({ quality: '2160p' })] })).includes('no-gpu'));
});

test('audio the browser cannot play is only informational (compat mode converts it)', () => {
  const device = { ...goodDevice, audioCodecs: ['aac', 'mp3'] };
  const s = stream({ audioRisk: 'AC3' });
  const r = evaluate({ device, streams: [s] });
  assert.equal(streamVerdict(s, device).level, 'compat');
  assert.equal(r.problems[0].id, 'audio');
  assert.equal(r.needsAttention, false);
});

test('Stremio being down: error for the host, error for a guest without relay, info with relay', () => {
  const device = { ...goodDevice, stremio: false };
  const streams = [stream({})];
  assert.equal(evaluate({ device, streams, isHost: true }).problems[0].level, 'error');
  assert.equal(evaluate({ device, streams, relayEnabled: false }).problems[0].level, 'error');
  const guest = evaluate({ device, streams, relayEnabled: true });
  assert.equal(guest.problems[0].level, 'info');
  assert.equal(guest.needsAttention, false);
});

test('a phone cannot open anything when the host turned the relay off', () => {
  const device = { ...goodDevice, stremio: null, touch: true };
  assert.equal(evaluate({ device, streams: [stream({})], relayEnabled: true }).needsAttention, false);
  assert.equal(evaluate({ device, streams: [stream({})], relayEnabled: false }).problems[0].level, 'error');
});

test('recommendation prefers SDR over HDR on an SDR screen and never a re-encode stream', () => {
  const device = { ...goodDevice, screenHdr: false };
  const hdr4k = stream({ quality: '2160p', hdr: 'HDR', videoRisk: 'HEVC', seeders: 500 });
  const sdr1080 = stream({ quality: '1080p', seeders: 50 });
  const streams = [hdr4k, sdr1080];
  const verdicts = new Map(streams.map((s) => [s.streamId, streamVerdict(s, device)]));
  assert.equal(pickBest(streams, verdicts, device).streamId, sdr1080.streamId);
  const noHevc = { ...device, videoCodecs: ['h264'] };
  const v2 = new Map(streams.map((s) => [s.streamId, streamVerdict(s, noHevc)]));
  assert.equal(pickBest([hdr4k], v2, noHevc), null);
});

test('problems are ordered errors first, then warnings, then info', () => {
  const device = { ...goodDevice, stremio: false, screenHdr: false, audioCodecs: ['aac'] };
  const streams = [stream({ hdr: 'HDR', videoRisk: 'HEVC', audioRisk: 'AC3', quality: '2160p' })];
  const levels = evaluate({ device, streams, isHost: true }).problems.map((p) => p.level);
  assert.deepEqual(levels, [...levels].sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a] - { error: 0, warn: 1, info: 2 }[b])));
  assert.equal(levels[0], 'error');
});

test('auto scan takes the well-seeded torrents, best first and capped', async () => {
  const { autoScanTargets, AUTO_SCAN_MAX } = await import('../public/js/compat.js');
  const strong = Array.from({ length: 9 }, (_, i) => stream({ seeders: 100 + i }));
  const weak = [stream({ seeders: 10 }), stream({ seeders: 49 })];
  const unknown = stream({ seeders: null });
  const picked = autoScanTargets([...weak, unknown, ...strong]);
  assert.equal(picked.length, AUTO_SCAN_MAX);
  assert.ok(picked.every((s) => s.seeders >= 100));
  assert.deepEqual(picked.map((s) => s.seeders), [...picked.map((s) => s.seeders)].sort((a, b) => b - a));
});

test('auto scan falls back to the top five when nothing is well seeded, and skips unknown seeds and http', async () => {
  const { autoScanTargets, AUTO_SCAN_FALLBACK } = await import('../public/js/compat.js');
  const few = [5, 30, 99, 12, 2, 40, 7].map((seeders) => stream({ seeders }));
  const picked = autoScanTargets([...few, stream({ seeders: null }), stream({ kind: 'http', seeders: 999 })]);
  assert.equal(picked.length, AUTO_SCAN_FALLBACK);
  assert.deepEqual(picked.map((s) => s.seeders), [99, 40, 30, 12, 7]);
  assert.deepEqual(autoScanTargets([]), []);
});
