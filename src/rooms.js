// Room state machine. Pure: no timers, no sockets. Every mutating method
// returns { msgs } (or { error }) where each msg is
// { to: 'room' | userId, event, data, urgent? } for the socket layer to deliver.

import crypto from 'node:crypto';
import { validateSettings } from './config.js';
import { guestStreamList } from './streams.js';

export const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const USER_STATES = ['idle', 'loading', 'ready', 'buffering', 'error', 'noStremio'];
export const USER_SOURCES = ['local', 'relay', 'http', 'none'];
const WAITABLE = new Set(['loading', 'buffering']);
const CHAT_KEEP = 200;
const CHAT_MAX = 500;
const CHAT_RATE = { count: 5, windowMs: 5000 };

function randomString(len, alphabet) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const defaultToken = () => crypto.randomBytes(16).toString('hex');
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Room {
  constructor({ id, type, contentId, meta, streams, hostStreamId, settings, creatorToken, clock }) {
    this.id = id;
    this.type = type;
    this.contentId = contentId;
    this.meta = meta || {};
    this.streams = streams;
    this.hostStreamId = hostStreamId;
    this.settings = { ...settings };
    this.creatorToken = creatorToken;
    this.clock = clock;
    this.createdAt = clock();

    this.hostUserId = null;
    this.users = new Map();
    this.bannedTokens = new Set();
    this.playback = { paused: true, position: 0, updatedAt: this.createdAt };
    this.autoPaused = false;
    this.waitingUserIds = [];
    this.skippedUserIds = new Set();
    this.chatLog = [];
    this.chatSeq = 0;
    this.subtitles = [];
    this.hostSubtitle = null;
    this.emptySince = this.createdAt;
  }

  // ---- helpers -----------------------------------------------------------

  now() {
    return this.clock();
  }

  currentPosition() {
    const pb = this.playback;
    if (pb.paused) return pb.position;
    return pb.position + (this.now() - pb.updatedAt) / 1000;
  }

  findByToken(token) {
    for (const u of this.users.values()) if (u.token === token) return u;
    return null;
  }

  connectedUsers() {
    return [...this.users.values()].filter((u) => u.connected);
  }

  guestStreams() {
    return guestStreamList(this.streams, this.hostStreamId);
  }

  usersView() {
    return [...this.users.values()].map((u) => ({
      id: u.id,
      name: u.name,
      connected: u.connected,
      isHost: u.id === this.hostUserId,
      status: u.status,
      ownStreamId: u.ownStreamId,
      relay: Boolean(u.relayKey),
    }));
  }

  usersMsg(urgent = false) {
    return { to: 'room', event: 'users', data: { users: this.usersView() }, urgent };
  }

  playbackMsg(by) {
    return {
      to: 'room',
      event: 'playback',
      data: { playback: { ...this.playback }, autoPaused: this.autoPaused, by: by ?? null },
      urgent: true,
    };
  }

  systemChat(text) {
    const entry = { id: ++this.chatSeq, fromId: null, from: null, text, ts: this.now(), system: true };
    this.pushChat(entry);
    return { to: 'room', event: 'chat', data: entry, urgent: true };
  }

  pushChat(entry) {
    this.chatLog.push(entry);
    if (this.chatLog.length > CHAT_KEEP) this.chatLog.shift();
  }

  requireHost(userId) {
    return userId === this.hostUserId ? null : { error: 'notHost' };
  }

  setHost(userId) {
    this.hostUserId = userId;
    const name = this.users.get(userId)?.name;
    return [
      { to: 'room', event: 'hostChanged', data: { hostUserId: userId }, urgent: true },
      this.systemChat(`${name} artık host`),
    ];
  }

  // Applies the wait rules; returns playback/waiting messages when they change.
  reevaluate() {
    const msgs = [];
    const intendsToPlay = !this.playback.paused || this.autoPaused;
    let blockers = [];
    if (this.settings.waitMode === 'wait' && intendsToPlay) {
      blockers = this.connectedUsers()
        .filter((u) => WAITABLE.has(u.status.state) && !this.skippedUserIds.has(u.id))
        .map((u) => u.id)
        .sort();
    }

    if (blockers.length && !this.playback.paused) {
      this.playback = { paused: true, position: this.currentPosition(), updatedAt: this.now() };
      this.autoPaused = true;
      msgs.push(this.playbackMsg(null));
    } else if (!blockers.length && this.autoPaused) {
      this.playback = { paused: false, position: this.playback.position, updatedAt: this.now() };
      this.autoPaused = false;
      msgs.push(this.playbackMsg(null));
    }

    if (!sameList(blockers, this.waitingUserIds)) {
      this.waitingUserIds = blockers;
      msgs.push({ to: 'room', event: 'waiting', data: { userIds: blockers }, urgent: true });
    }
    return msgs;
  }

  // ---- membership --------------------------------------------------------

  join({ token, name, socketId }) {
    if (typeof token !== 'string' || token.length < 8 || token.length > 128) return { error: 'badToken' };
    const cleanName = typeof name === 'string' ? name.trim().slice(0, 30) : '';
    if (!cleanName) return { error: 'badName' };
    if (this.bannedTokens.has(token)) return { error: 'banned' };

    const msgs = [];
    let user = this.findByToken(token);
    let previousSocketId = null;
    if (user) {
      previousSocketId = user.socketId;
      const wasAway = !user.connected;
      Object.assign(user, { name: cleanName, socketId, connected: true, disconnectedAt: null });
      if (wasAway) msgs.push(this.systemChat(`${cleanName} geri döndü`));
    } else {
      user = {
        id: randomString(8, 'abcdefghijkmnpqrstuvwxyz23456789'),
        token,
        name: cleanName,
        socketId,
        connected: true,
        joinedAt: this.now(),
        disconnectedAt: null,
        ownStreamId: null,
        relayKey: null,
        status: { state: 'idle', source: 'none', drift: null, duration: null, quality: null },
        chatTimes: [],
      };
      this.users.set(user.id, user);
      msgs.push(this.systemChat(`${cleanName} katıldı`));
    }
    this.emptySince = null;

    const isCreator = token === this.creatorToken;
    if ((isCreator && this.hostUserId !== user.id) || this.hostUserId === null) {
      msgs.push(...this.setHost(user.id));
    }
    msgs.push(this.usersMsg(true), ...this.reevaluate());
    return { user, msgs, previousSocketId };
  }

  disconnect(userId, socketId) {
    const user = this.users.get(userId);
    if (!user || !user.connected || user.socketId !== socketId) return { msgs: [] };
    user.connected = false;
    user.disconnectedAt = this.now();
    user.status = { ...user.status, state: 'idle', source: 'none' };
    user.relayKey = null;
    this.skippedUserIds.delete(userId);
    if (!this.connectedUsers().length) this.emptySince = this.now();
    const msgs = [this.systemChat(`${user.name} ayrıldı`), this.usersMsg(true), ...this.reevaluate()];
    return { msgs };
  }

  kick(byUserId, targetId, { byPanel = false } = {}) {
    if (!byPanel) {
      const denied = this.requireHost(byUserId);
      if (denied) return denied;
    }
    const target = this.users.get(targetId);
    if (!target || targetId === this.hostUserId) return { error: 'badTarget' };
    this.bannedTokens.add(target.token);
    this.users.delete(targetId);
    this.skippedUserIds.delete(targetId);
    if (!this.connectedUsers().length) this.emptySince = this.now();
    const msgs = [this.systemChat(`${target.name} odadan çıkarıldı`), this.usersMsg(true), ...this.reevaluate()];
    return { msgs, kickedSocketId: target.connected ? target.socketId : null };
  }

  tick() {
    const host = this.users.get(this.hostUserId);
    if (!host || host.connected) return [];
    if (this.now() - host.disconnectedAt < this.graceMs) return [];
    const next = this.connectedUsers().sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (!next) return [];
    return [...this.setHost(next.id), this.usersMsg(true)];
  }

  // ---- playback ----------------------------------------------------------

  control(userId, { action, position } = {}) {
    const user = this.users.get(userId);
    if (!user?.connected) return { error: 'notInRoom' };
    if (this.settings.locked && userId !== this.hostUserId) return { error: 'locked' };
    if (!['play', 'pause', 'seek'].includes(action)) return { error: 'badAction' };
    const valid = Number.isFinite(position) && position >= 0;
    if (action === 'seek' && !valid) return { error: 'badPosition' };
    if (position !== undefined && !valid) return { error: 'badPosition' };
    const pos = valid ? position : this.currentPosition();
    const now = this.now();

    if (action === 'play') {
      this.skippedUserIds.clear();
      this.playback = { paused: false, position: pos, updatedAt: now };
      this.autoPaused = false;
      // In wait mode the room only starts once nobody is loading.
      const blocked = this.settings.waitMode === 'wait'
        && this.connectedUsers().some((u) => WAITABLE.has(u.status.state));
      if (blocked) {
        this.playback.paused = true;
        this.autoPaused = true;
      }
    } else if (action === 'pause') {
      this.playback = { paused: true, position: pos, updatedAt: now };
      this.autoPaused = false;
    } else {
      this.playback = { ...this.playback, position: pos, updatedAt: now };
    }
    return { msgs: [this.playbackMsg(user.name), ...this.reevaluate()] };
  }

  status(userId, st = {}) {
    const user = this.users.get(userId);
    if (!user?.connected) return { error: 'notInRoom' };
    if (!USER_STATES.includes(st.state) || !USER_SOURCES.includes(st.source)) return { error: 'badStatus' };
    const num = (v) => (Number.isFinite(v) ? v : null);
    const prev = user.status.state;
    user.status = {
      state: st.state,
      source: st.source,
      drift: num(st.drift),
      duration: num(st.duration) !== null && st.duration >= 0 ? st.duration : null,
      quality: typeof st.quality === 'string' ? st.quality.slice(0, 10) : null,
    };
    if (st.state === 'ready') this.skippedUserIds.delete(userId);
    const changed = prev !== st.state;
    return { msgs: [this.usersMsg(changed), ...(changed ? this.reevaluate() : [])] };
  }

  skipWaiting(userId) {
    const denied = this.requireHost(userId);
    if (denied) return denied;
    if (!this.waitingUserIds.length) return { msgs: [] };
    for (const id of this.waitingUserIds) this.skippedUserIds.add(id);
    return { msgs: [this.systemChat('Host beklemeyi atladı'), ...this.reevaluate()] };
  }

  updateSettings(userId, partial = {}) {
    const denied = this.requireHost(userId);
    if (denied) return denied;
    const errors = [];
    const merged = validateSettings({ ...this.settings, ...partial }, errors, 'settings');
    if (errors.length) return { error: errors.join('; ') };
    this.settings = merged;
    const msgs = [{ to: 'room', event: 'settings', data: { ...merged }, urgent: true }];
    msgs.push(...this.onSettingsChanged(), ...this.reevaluate());
    return { msgs };
  }

  // Hook for features that react to settings (relay limit). Returns msgs.
  onSettingsChanged() {
    return [];
  }

  // ---- streams -----------------------------------------------------------

  setOwnStream(userId, streamId) {
    const user = this.users.get(userId);
    if (!user?.connected) return { error: 'notInRoom' };
    if (streamId !== null && !this.guestStreams().some((s) => s.streamId === streamId)) {
      return { error: 'badStream' };
    }
    user.ownStreamId = streamId === this.hostStreamId ? null : streamId;
    return { msgs: [this.usersMsg(false)] };
  }

  setHostStream(userId, streamId) {
    const denied = this.requireHost(userId);
    if (denied) return denied;
    const stream = this.streams.find((s) => s.streamId === streamId);
    if (!stream) return { error: 'badStream' };
    this.hostStreamId = streamId;
    const visible = new Set(this.guestStreams().map((s) => s.streamId));
    for (const u of this.users.values()) {
      if (u.ownStreamId && (!visible.has(u.ownStreamId) || u.ownStreamId === streamId)) u.ownStreamId = null;
    }
    const label = [stream.quality, stream.addonName].filter(Boolean).join(' · ');
    return {
      msgs: [
        { to: 'room', event: 'hostStream', data: { hostStreamId: streamId, streams: this.guestStreams() }, urgent: true },
        this.systemChat(`Host stream'i değiştirdi${label ? `: ${label}` : ''}`),
        this.usersMsg(true),
      ],
      stream,
    };
  }

  // ---- subtitles ---------------------------------------------------------

  publicSubtitles() {
    return this.subtitles.map(({ subId, lang, label, source, matched }) => ({ subId, lang, label, source, matched }));
  }

  // Replaces the list (entries keep their server-only url/vtt fields).
  setSubtitles(list) {
    this.subtitles = list;
    const msgs = [{ to: 'room', event: 'subtitles', data: { subtitles: this.publicSubtitles() }, urgent: true }];
    if (this.hostSubtitle && !list.some((s) => s.subId === this.hostSubtitle.subId)) {
      this.hostSubtitle = null;
      msgs.push({ to: 'room', event: 'hostSubtitle', data: null, urgent: true });
    }
    return msgs;
  }

  setHostSubtitle(userId, { subId = null, offset = 0 } = {}) {
    const denied = this.requireHost(userId);
    if (denied) return denied;
    const entry = subId === null ? null : this.subtitles.find((s) => s.subId === subId);
    if (subId !== null && !entry) return { error: 'badSubtitle' };
    if (!Number.isFinite(offset) || Math.abs(offset) > 600) return { error: 'badOffset' };
    const changed = (this.hostSubtitle?.subId ?? null) !== subId;
    this.hostSubtitle = entry ? { subId, offset } : null;
    const msgs = [{ to: 'room', event: 'hostSubtitle', data: this.hostSubtitle, urgent: true }];
    if (changed) msgs.push(this.systemChat(entry ? `Host altyazıyı seçti: ${entry.label}` : 'Host altyazıyı kapattı'));
    return { msgs };
  }

  // ---- chat --------------------------------------------------------------

  chat(userId, text) {
    const user = this.users.get(userId);
    if (!user?.connected) return { error: 'notInRoom' };
    const clean = typeof text === 'string' ? text.trim() : '';
    if (!clean) return { error: 'empty' };
    if (clean.length > CHAT_MAX) return { error: 'tooLong' };
    const now = this.now();
    user.chatTimes = user.chatTimes.filter((t) => now - t < CHAT_RATE.windowMs);
    if (user.chatTimes.length >= CHAT_RATE.count) return { error: 'rate' };
    user.chatTimes.push(now);
    const entry = { id: ++this.chatSeq, fromId: user.id, from: user.name, text: clean, ts: now, system: false };
    this.pushChat(entry);
    return { msgs: [{ to: 'room', event: 'chat', data: entry, urgent: true }] };
  }

  // ---- views -------------------------------------------------------------

  snapshot(userId) {
    return {
      id: this.id,
      type: this.type,
      contentId: this.contentId,
      meta: this.meta,
      settings: { ...this.settings },
      hostUserId: this.hostUserId,
      hostStreamId: this.hostStreamId,
      streams: this.guestStreams(),
      subtitles: this.publicSubtitles(),
      hostSubtitle: this.hostSubtitle,
      playback: { ...this.playback },
      autoPaused: this.autoPaused,
      waitingUserIds: this.waitingUserIds,
      chat: this.chatLog,
      users: this.usersView(),
      you: userId,
      serverNow: this.now(),
    };
  }

  summary() {
    return {
      id: this.id,
      meta: this.meta,
      contentId: this.contentId,
      createdAt: this.createdAt,
      settings: { ...this.settings },
      playback: { ...this.playback, position: this.currentPosition() },
      hostStreamId: this.hostStreamId,
      users: this.usersView(),
    };
  }
}

export function createRoomManager({
  now = Date.now,
  token = defaultToken,
  graceMs = 30_000,
  emptyTtlMs = 300_000,
  RoomClass = Room,
} = {}) {
  const rooms = new Map();

  function newId() {
    let id;
    do id = randomString(6, ROOM_ID_ALPHABET);
    while (rooms.has(id));
    return id;
  }

  return {
    create({ type, contentId, meta, streams, hostStreamId, settings }) {
      const creatorToken = token();
      const room = new RoomClass({
        id: newId(), type, contentId, meta, streams, hostStreamId, settings, creatorToken, clock: now,
      });
      room.graceMs = graceMs;
      rooms.set(room.id, room);
      return { room, creatorToken };
    },
    get: (id) => rooms.get(id),
    list: () => [...rooms.values()],
    close: (id) => rooms.delete(id),
    tick() {
      const out = [];
      for (const room of rooms.values()) {
        const msgs = room.tick();
        const deleted = room.emptySince !== null && now() - room.emptySince >= emptyTtlMs;
        if (deleted) rooms.delete(room.id);
        if (msgs.length || deleted) out.push({ room, msgs, deleted });
      }
      return out;
    },
  };
}
