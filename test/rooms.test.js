import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomManager, ROOM_ID_ALPHABET } from '../src/rooms.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const IH = 'a'.repeat(40);
const STREAMS = [
  { streamId: 's1', kind: 'torrent', infoHash: IH, fileIdx: 0, quality: '1080p', addonName: 'T' },
  { streamId: 's2', kind: 'torrent', infoHash: 'b'.repeat(40), fileIdx: 0, quality: '720p', addonName: 'T' },
  { streamId: 's3', kind: 'http', url: 'https://rd/secret', quality: '2160p', addonName: 'RD' },
];

function setup(settings = {}) {
  const clock = { t: 1_000_000 };
  let seq = 0;
  const mgr = createRoomManager({
    now: () => clock.t,
    token: () => `token-${++seq}-xxxxxxxx`,
    graceMs: 30_000,
    emptyTtlMs: 300_000,
  });
  const { room, creatorToken } = mgr.create({
    type: 'movie',
    contentId: 'tt123',
    meta: { name: 'Film', poster: null },
    streams: STREAMS,
    hostStreamId: 's1',
    settings: { ...DEFAULT_CONFIG.defaults, ...settings },
  });
  const host = room.join({ token: creatorToken, name: 'Host', socketId: 'sock-h' }).user;
  const join = (name) =>
    room.join({ token: `tok-${name}-xxxxxxxx`, name, socketId: `sock-${name}` }).user;
  const advance = (ms) => { clock.t += ms; };
  return { mgr, room, host, join, clock, advance, creatorToken };
}

const events = (msgs, name) => msgs.filter((m) => m.event === name);
const ready = (room, user) => room.status(user.id, { state: 'ready', source: 'local' });

test('room ids use the unambiguous alphabet', () => {
  const { room } = setup();
  assert.match(room.id, new RegExp(`^[${ROOM_ID_ALPHABET}]{6}$`));
  assert.ok(!/[01ILO]/.test(ROOM_ID_ALPHABET));
});

test('creator becomes host on join', () => {
  const { room, host } = setup();
  assert.equal(room.hostUserId, host.id);
});

test('first joiner is host until the creator arrives, then creator takes it back', () => {
  const clock = { t: 0 };
  const mgr = createRoomManager({ now: () => clock.t });
  const { room, creatorToken } = mgr.create({
    type: 'movie', contentId: 'tt1', meta: {}, streams: STREAMS, hostStreamId: 's1', settings: DEFAULT_CONFIG.defaults,
  });
  const guest = room.join({ token: 'guest-token-xxxx', name: 'G', socketId: 'g' }).user;
  assert.equal(room.hostUserId, guest.id);
  const res = room.join({ token: creatorToken, name: 'C', socketId: 'c' });
  assert.equal(room.hostUserId, res.user.id);
  assert.equal(events(res.msgs, 'hostChanged').length, 1);
});

test('join validates name and token', () => {
  const { room } = setup();
  assert.deepEqual(room.join({ token: 'short', name: 'x', socketId: 's' }), { error: 'badToken' });
  assert.deepEqual(room.join({ token: 'long-enough-token', name: '   ', socketId: 's' }), { error: 'badName' });
});

test('rejoining with the same token returns the same user and previous socket', () => {
  const { room, join } = setup();
  const ali = join('ali');
  const again = room.join({ token: 'tok-ali-xxxxxxxx', name: 'Ali2', socketId: 'new-sock' });
  assert.equal(again.user.id, ali.id);
  assert.equal(again.previousSocketId, 'sock-ali');
  assert.equal(again.user.name, 'Ali2');
});

test('locked room rejects guest controls, allows host', () => {
  const { room, host, join } = setup({ locked: true, waitMode: 'continue' });
  const ali = join('ali');
  assert.deepEqual(room.control(ali.id, { action: 'play', position: 0 }), { error: 'locked' });
  const res = room.control(host.id, { action: 'play', position: 5 });
  assert.equal(res.error, undefined);
  assert.equal(room.playback.paused, false);
  assert.equal(room.playback.position, 5);
  assert.equal(events(res.msgs, 'playback')[0].data.by, 'Host');
});

test('unlocked room lets guests control', () => {
  const { room, join } = setup({ locked: false, waitMode: 'continue' });
  const ali = join('ali');
  room.control(ali.id, { action: 'play', position: 0 });
  assert.equal(room.playback.paused, false);
});

test('control validates action and position', () => {
  const { room, host } = setup();
  assert.deepEqual(room.control(host.id, { action: 'dance' }), { error: 'badAction' });
  assert.deepEqual(room.control(host.id, { action: 'seek', position: -3 }), { error: 'badPosition' });
  assert.deepEqual(room.control(host.id, { action: 'seek' }), { error: 'badPosition' });
});

test('pause stores the given position, playback advances with time', () => {
  const { room, host, advance } = setup({ waitMode: 'continue' });
  room.control(host.id, { action: 'play', position: 10 });
  advance(4000);
  assert.equal(room.currentPosition(), 14);
  room.control(host.id, { action: 'pause', position: 14.2 });
  advance(4000);
  assert.equal(room.currentPosition(), 14.2);
});

test('wait mode: play waits for users still loading, then starts', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  room.status(ali.id, { state: 'loading', source: 'local' });
  const res = room.control(host.id, { action: 'play', position: 0 });
  assert.equal(room.playback.paused, true);
  assert.equal(room.autoPaused, true);
  assert.deepEqual(events(res.msgs, 'waiting')[0].data.userIds, [ali.id]);

  const res2 = ready(room, ali);
  assert.equal(room.playback.paused, false);
  assert.equal(room.autoPaused, false);
  assert.deepEqual(events(res2.msgs, 'waiting')[0].data.userIds, []);
});

test('wait mode: buffering user auto-pauses the room at the current position', () => {
  const { room, host, join, advance } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  ready(room, ali);
  room.control(host.id, { action: 'play', position: 100 });
  advance(3000);
  const { msgs } = room.status(ali.id, { state: 'buffering', source: 'local' });
  assert.equal(room.playback.paused, true);
  assert.equal(room.playback.position, 103);
  assert.equal(events(msgs, 'playback').length, 1);
  advance(5000);
  ready(room, ali);
  assert.equal(room.playback.paused, false);
  assert.equal(room.playback.position, 103);
});

test('wait mode: manual pause while waiting cancels auto resume', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  ready(room, ali);
  room.control(host.id, { action: 'play', position: 0 });
  room.status(ali.id, { state: 'buffering', source: 'local' });
  room.control(host.id, { action: 'pause', position: 0 });
  ready(room, ali);
  assert.equal(room.playback.paused, true);
});

test('wait mode: idle, noStremio and error users never block', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const a = join('a');
  const b = join('b');
  const c = join('c');
  ready(room, host);
  room.status(a.id, { state: 'idle', source: 'none' });
  room.status(b.id, { state: 'noStremio', source: 'none' });
  room.status(c.id, { state: 'error', source: 'local' });
  room.control(host.id, { action: 'play', position: 0 });
  assert.equal(room.playback.paused, false);
});

test('wait mode: disconnecting blocker releases the wait', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  room.status(ali.id, { state: 'loading', source: 'local' });
  room.control(host.id, { action: 'play', position: 0 });
  assert.equal(room.playback.paused, true);
  room.disconnect(ali.id, 'sock-ali');
  assert.equal(room.playback.paused, false);
});

test('stale socket disconnect is ignored', () => {
  const { room, join } = setup();
  const ali = join('ali');
  room.join({ token: 'tok-ali-xxxxxxxx', name: 'ali', socketId: 'second' });
  room.disconnect(ali.id, 'sock-ali');
  assert.equal(room.users.get(ali.id).connected, true);
});

test('skipWaiting resumes now; skipped user blocks again after becoming ready', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  ready(room, ali);
  room.control(host.id, { action: 'play', position: 0 });
  room.status(ali.id, { state: 'buffering', source: 'local' });
  assert.equal(room.playback.paused, true);

  assert.deepEqual(room.skipWaiting(ali.id), { error: 'notHost' });
  room.skipWaiting(host.id);
  assert.equal(room.playback.paused, false);

  room.status(ali.id, { state: 'buffering', source: 'local' });
  assert.equal(room.playback.paused, false, 'still skipped while buffering');

  ready(room, ali);
  room.status(ali.id, { state: 'buffering', source: 'local' });
  assert.equal(room.playback.paused, true, 'blocks again after being ready');
});

test('continue mode never auto-pauses', () => {
  const { room, host, join } = setup({ waitMode: 'continue' });
  const ali = join('ali');
  ready(room, host);
  room.status(ali.id, { state: 'loading', source: 'local' });
  room.control(host.id, { action: 'play', position: 0 });
  room.status(ali.id, { state: 'buffering', source: 'local' });
  assert.equal(room.playback.paused, false);
  assert.deepEqual(room.waitingUserIds, []);
});

test('switching to continue while auto-paused resumes playback', () => {
  const { room, host, join } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  ready(room, host);
  ready(room, ali);
  room.control(host.id, { action: 'play', position: 0 });
  room.status(ali.id, { state: 'buffering', source: 'local' });
  const res = room.updateSettings(host.id, { waitMode: 'continue' });
  assert.equal(room.playback.paused, false);
  assert.equal(events(res.msgs, 'settings')[0].data.waitMode, 'continue');
});

test('updateSettings is host only and validated', () => {
  const { room, host, join } = setup();
  const ali = join('ali');
  assert.deepEqual(room.updateSettings(ali.id, { locked: false }), { error: 'notHost' });
  assert.match(room.updateSettings(host.id, { waitMode: 'x' }).error, /waitMode/);
  room.updateSettings(host.id, { locked: false, unknown: 1 });
  assert.equal(room.settings.locked, false);
  assert.equal(room.settings.unknown, undefined);
});

test('status is validated', () => {
  const { room, host } = setup();
  assert.deepEqual(room.status(host.id, { state: 'weird', source: 'local' }), { error: 'badStatus' });
  assert.deepEqual(room.status(host.id, { state: 'ready', source: 'moon' }), { error: 'badStatus' });
});

test('host handover after grace, creator reclaims on return', () => {
  const { room, host, join, advance } = setup();
  const ali = join('ali');
  advance(10);
  const bob = join('bob');
  room.disconnect(host.id, 'sock-h');
  advance(29_000);
  assert.deepEqual(events(room.tick(), 'hostChanged'), []);
  assert.equal(room.hostUserId, host.id);
  advance(2_000);
  const msgs = room.tick();
  assert.equal(room.hostUserId, ali.id, 'oldest connected user');
  assert.equal(events(msgs, 'hostChanged').length, 1);
  assert.ok(bob);

  const back = room.join({ token: room.creatorToken, name: 'Host', socketId: 'sock-h2' });
  assert.equal(room.hostUserId, host.id);
  assert.equal(events(back.msgs, 'hostChanged').length, 1);
});

test('host returning within grace keeps host', () => {
  const { room, host, join, advance } = setup();
  join('ali');
  room.disconnect(host.id, 'sock-h');
  advance(10_000);
  room.join({ token: room.creatorToken, name: 'Host', socketId: 'sock-h2' });
  advance(60_000);
  room.tick();
  assert.equal(room.hostUserId, host.id);
});

test('kick bans the token and reports the socket to close', () => {
  const { room, host, join } = setup();
  const ali = join('ali');
  assert.deepEqual(room.kick(ali.id, host.id), { error: 'notHost' });
  assert.deepEqual(room.kick(host.id, host.id), { error: 'badTarget' });
  const res = room.kick(host.id, ali.id);
  assert.equal(res.kickedSocketId, 'sock-ali');
  assert.equal(room.users.has(ali.id), false);
  assert.deepEqual(room.join({ token: 'tok-ali-xxxxxxxx', name: 'ali', socketId: 'x' }), { error: 'banned' });
});

test('panel can kick without being host', () => {
  const { room, join } = setup();
  const ali = join('ali');
  const res = room.kick(null, ali.id, { byPanel: true });
  assert.equal(res.kickedSocketId, 'sock-ali');
});

test('chat: trims, limits length and rate, keeps last 200', () => {
  const { room, host, advance } = setup();
  assert.deepEqual(room.chat(host.id, '   '), { error: 'empty' });
  assert.deepEqual(room.chat(host.id, 'x'.repeat(501)), { error: 'tooLong' });
  for (let i = 0; i < 5; i++) assert.equal(room.chat(host.id, `m${i}`).error, undefined);
  assert.deepEqual(room.chat(host.id, 'm5'), { error: 'rate' });
  advance(5001);
  const res = room.chat(host.id, ' <b>hi</b> ');
  assert.equal(events(res.msgs, 'chat')[0].data.text, '<b>hi</b>');
  for (let i = 0; i < 300; i++) {
    advance(2000);
    room.chat(host.id, `bulk${i}`);
  }
  assert.equal(room.chatLog.length, 200);
});

test('host stream change moves followers, keeps own-stream users, drops hidden http picks', () => {
  const { room, host, join } = setup();
  const ali = join('ali');
  const bob = join('bob');
  assert.deepEqual(room.setOwnStream(ali.id, 's3'), { error: 'badStream' }, 'http not visible to guests');
  room.setOwnStream(ali.id, 's2');
  assert.deepEqual(room.setHostStream(ali.id, 's2'), { error: 'notHost' });

  const res = room.setHostStream(host.id, 's3');
  const ev = events(res.msgs, 'hostStream')[0].data;
  assert.equal(ev.hostStreamId, 's3');
  assert.deepEqual(ev.streams.map((s) => s.streamId), ['s1', 's2', 's3']);
  assert.equal(room.users.get(ali.id).ownStreamId, 's2');
  assert.equal(room.users.get(bob.id).ownStreamId, null);

  room.setOwnStream(bob.id, 's3');
  room.setHostStream(host.id, 's1');
  assert.equal(room.users.get(bob.id).ownStreamId, null, 'no longer visible');
});

test('setContent switches the room to a new title, resets playback/subs/own-stream picks, host only', () => {
  const { room, host, join } = setup();
  const ali = join('ali');
  room.setOwnStream(ali.id, 's2');
  room.control(host.id, { action: 'play', position: 42 });
  room.setSubtitles([{ subId: 'sub1', lang: 'tr', label: 'TR', source: 'x', matched: true }]);
  room.setHostSubtitle(host.id, { subId: 'sub1' });

  assert.deepEqual(
    room.setContent(ali.id, { type: 'movie', contentId: 'tt999', meta: {}, streams: STREAMS, hostStreamId: 's1' }),
    { error: 'notHost' },
  );

  const newStreams = [{ streamId: 'n1', kind: 'torrent', infoHash: 'c'.repeat(40), fileIdx: 0, quality: '1080p', addonName: 'T' }];
  const res = room.setContent(host.id, { type: 'series', contentId: 'tt999:1:2', meta: { name: 'Other Show' }, streams: newStreams, hostStreamId: 'n1' });
  const ev = events(res.msgs, 'content')[0].data;
  assert.equal(ev.contentId, 'tt999:1:2');
  assert.equal(ev.hostStreamId, 'n1');
  assert.equal(room.type, 'series');
  assert.equal(room.meta.name, 'Other Show');
  assert.equal(room.users.get(ali.id).ownStreamId, null, 'old own-stream pick is gone');
  assert.equal(room.playback.paused, true);
  assert.equal(room.playback.position, 0);
  assert.deepEqual(room.subtitles, []);
  assert.equal(room.hostSubtitle, null);
});

test('addStreams merges only genuinely new streams, host only', () => {
  const { room, host, join } = setup();
  const ali = join('ali');
  assert.deepEqual(room.addStreams(ali.id, []), { error: 'notHost' });

  // s1/s2 are torrent dupes of existing streams (same infoHash+fileIdx); s3 is
  // an http dupe by url; only the two genuinely new ones should be added.
  const res = room.addStreams(host.id, [
    { kind: 'torrent', infoHash: IH, fileIdx: 0, quality: '1080p', addonName: 'T' }, // dup of STREAMS[0]
    { kind: 'http', url: 'https://rd/secret', quality: '2160p', addonName: 'RD' }, // dup of STREAMS[2]
    { kind: 'torrent', infoHash: 'd'.repeat(40), fileIdx: 0, quality: '4k', addonName: 'Torrentio' },
    { kind: 'http', url: 'https://new/link', quality: '1080p', addonName: 'RD2' },
  ]);
  assert.equal(res.added, 2);
  assert.equal(room.streams.length, 5);
  const added = room.streams.slice(3);
  assert.deepEqual(added.map((s) => s.addonName), ['Torrentio', 'RD2']);
  assert.deepEqual(new Set(added.map((s) => s.streamId)).size, 2, 'new streamIds are unique');
  // guestStreams() only ever shows torrents plus the host's own http pick —
  // s3 (http, not the host pick) was already hidden, and the new RD2 http
  // stream is hidden the same way, so only the 3 torrents show up here.
  const ev = events(res.msgs, 'hostStream')[0].data;
  assert.equal(ev.streams.length, 3);

  assert.deepEqual(room.addStreams(host.id, []).msgs, [], 'nothing new -> no broadcast');
});

test('snapshot hides other http streams and user tokens', () => {
  const { room, host } = setup();
  const snap = room.snapshot(host.id);
  assert.deepEqual(snap.streams.map((s) => s.streamId), ['s1', 's2']);
  assert.equal(snap.you, host.id);
  assert.equal(JSON.stringify(snap).includes('token-'), false);
});

test('manager deletes rooms empty for the ttl', () => {
  const { mgr, room, host, advance } = setup();
  room.disconnect(host.id, 'sock-h');
  advance(299_000);
  assert.equal(mgr.tick().some((r) => r.deleted), false);
  advance(2_000);
  const res = mgr.tick();
  assert.equal(res.find((r) => r.room === room).deleted, true);
  assert.equal(mgr.get(room.id), undefined);
});

test('manager close removes the room', () => {
  const { mgr, room } = setup();
  assert.equal(mgr.close(room.id), true);
  assert.equal(mgr.get(room.id), undefined);
  assert.equal(mgr.close(room.id), false);
});

test('seek gate: room waits until every rev-reporting user reached the new position', () => {
  const { room, host, join, advance } = setup({ waitMode: 'wait' });
  const ali = join('ali');
  room.status(host.id, { state: 'ready', source: 'local', rev: 0 });
  room.status(ali.id, { state: 'ready', source: 'local', rev: 0 });
  room.control(host.id, { action: 'play', position: 0 });
  room.status(host.id, { state: 'ready', source: 'local', rev: 1 });
  room.status(ali.id, { state: 'ready', source: 'local', rev: 1 });
  assert.equal(room.playback.paused, false);

  const res = room.control(host.id, { action: 'seek', position: 500 });
  assert.equal(events(res.msgs, 'playback').length, 1);
  assert.equal(room.playback.paused, true);
  assert.equal(room.playback.position, 500);
  room.status(host.id, { state: 'ready', source: 'local', rev: 2 });
  assert.equal(room.playback.paused, true, 'ali has not arrived yet');
  room.status(ali.id, { state: 'ready', source: 'local', rev: 2 });
  assert.equal(room.playback.paused, false);

  room.control(host.id, { action: 'seek', position: 900 });
  assert.equal(room.playback.paused, true);
  advance(60_000);
  room.tick();
  assert.equal(room.playback.paused, true, 'no time limit');
  room.skipWaiting(host.id);
  assert.equal(room.playback.paused, false, 'host can skip');
});

test('yayını izleyenin kendi kaynağı kullanımda sayılmıyor (torrent kapanabilsin)', () => {
  const { room, join } = setup();
  const ali = join('ali');
  room.setOwnStream(ali.id, 's2');
  assert.ok(room.statsStreamIds().includes('s2'));
  room.status(ali.id, { state: 'idle', source: 'none', yayin: { yukseklik: 720, fps: 30, mbps: 4.2 } });
  assert.ok(!room.statsStreamIds().includes('s2'));
  assert.equal(room.users.get(ali.id).status.yayin.mbps, 4.2);
});
