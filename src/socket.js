// Socket.IO wiring: turns client events into Room calls and delivers the
// resulting messages.

const EVENTS_PER_SECOND = 20;
const JOIN_FAILS_PER_MINUTE = 10;

export function attachSocket(io, {
  rooms,
  log,
  now = Date.now,
  getPublicUrl = () => null,
  hooks = {},
  tickMs = 1000,
  usersThrottleMs = 1000,
}) {
  const usersTimers = new Map();
  const joinFailures = new Map(); // ip -> [timestamps]

  function sendUsers(room) {
    io.to(room.id).emit('users', { users: room.usersView() });
  }

  function dispatch(room, msgs = []) {
    for (const m of msgs) {
      if (m.event === 'users') {
        if (m.urgent) {
          clearTimeout(usersTimers.get(room.id));
          usersTimers.delete(room.id);
          sendUsers(room);
        } else if (!usersTimers.has(room.id)) {
          usersTimers.set(room.id, setTimeout(() => {
            usersTimers.delete(room.id);
            if (rooms.get(room.id)) sendUsers(room);
          }, usersThrottleMs));
        }
        continue;
      }
      if (m.to === 'room') io.to(room.id).emit(m.event, m.data);
      else {
        const sid = room.users.get(m.to)?.socketId;
        if (sid) io.to(sid).emit(m.event, m.data);
      }
    }
  }

  function dropSocket(socketId, event) {
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.emit(event);
    s.data.roomId = null;
    s.disconnect(true);
  }

  function clientIp(socket) {
    return socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;
  }

  function recentFailures(ip) {
    const list = (joinFailures.get(ip) || []).filter((t) => now() - t < 60_000);
    joinFailures.set(ip, list);
    return list;
  }

  function context(socket) {
    const room = socket.data.roomId && rooms.get(socket.data.roomId);
    return room ? { room, userId: socket.data.userId } : null;
  }

  io.on('connection', (socket) => {
    let windowStart = now();
    let count = 0;
    const allow = () => {
      if (now() - windowStart >= 1000) {
        windowStart = now();
        count = 0;
      }
      return ++count <= EVENTS_PER_SECOND;
    };

    function on(event, handler) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!allow()) return reply({ error: 'rate' });
        try {
          handler(payload && typeof payload === 'object' ? payload : {}, reply);
        } catch (err) {
          log.error('Socket olayı hata verdi', { event, error: err.message });
          reply({ error: 'server' });
        }
      });
    }

    // Room-bound event: fn(room, userId, payload) returns { msgs } or { error } (fn may be async).
    function onRoom(event, fn) {
      on(event, async (payload, reply) => {
        const ctx = context(socket);
        if (!ctx) return reply({ error: 'notJoined' });
        const res = await fn(ctx.room, ctx.userId, payload);
        if (res.error) return reply({ error: res.error });
        reply(res.reply ?? { ok: true });
        dispatch(ctx.room, res.msgs);
        if (res.kickedSocketId) dropSocket(res.kickedSocketId, 'kicked');
        res.after?.();
      });
    }

    on('join', ({ roomId, userToken, name }, reply) => {
      const ip = clientIp(socket);
      const failures = recentFailures(ip);
      if (failures.length >= JOIN_FAILS_PER_MINUTE) return reply({ error: 'tooMany' });
      if (socket.data.roomId) return reply({ error: 'alreadyJoined' });
      const room = typeof roomId === 'string' && rooms.get(roomId.toUpperCase());
      const res = room ? room.join({ token: userToken, name, socketId: socket.id }) : { error: 'notFound' };
      if (res.error) {
        failures.push(now());
        return reply({ error: res.error });
      }
      if (res.previousSocketId && res.previousSocketId !== socket.id) dropSocket(res.previousSocketId, 'replaced');
      socket.data.roomId = room.id;
      socket.data.userId = res.user.id;
      socket.join(room.id);
      reply({ ok: true, snapshot: room.snapshot(res.user.id), publicUrl: getPublicUrl(), yayin: hooks.yayinDurumu?.(room) ?? null });
      dispatch(room, res.msgs);
      dispatch(room, hooks.onJoin?.(room, res.user.id) || []);
    });

    on('time', (payload, reply) => reply(now()));

    onRoom('control', (room, uid, p) => room.control(uid, { action: p.action, position: p.position }));
    onRoom('status', (room, uid, p) => room.status(uid, p));
    onRoom('chat', (room, uid, p) => room.chat(uid, p.text));
    onRoom('setOwnStream', (room, uid, p) => room.setOwnStream(uid, p.streamId ?? null));
    onRoom('setHostStream', (room, uid, p) => {
      const res = room.setHostStream(uid, p.streamId);
      if (!res.error) res.after = () => hooks.onHostStream?.(room);
      return res;
    });
    onRoom('settings', (room, uid, p) => room.updateSettings(uid, { ...p, relayEnabled: false, relay4k: false })); // relay kapalı: kod duruyor, ayar açılamıyor
    onRoom('skipWaiting', (room, uid) => room.skipWaiting(uid));
    onRoom('kick', (room, uid, p) => room.kick(uid, p.userId));

    for (const [event, fn] of Object.entries(hooks.roomEvents || {})) onRoom(event, fn);

    socket.on('disconnect', () => {
      const ctx = context(socket);
      if (!ctx) return;
      dispatch(ctx.room, ctx.room.disconnect(ctx.userId, socket.id).msgs);
      dispatch(ctx.room, hooks.onDisconnect?.(ctx.room, ctx.userId) || []);
    });
  });

  function closeRoom(roomId, reason = 'closed') {
    const room = rooms.get(roomId);
    if (!room) return false;
    rooms.close(roomId);
    clearTimeout(usersTimers.get(roomId));
    usersTimers.delete(roomId);
    io.to(roomId).emit('roomClosed', { reason });
    io.in(roomId).disconnectSockets(true);
    hooks.onRoomClosed?.(room);
    return true;
  }

  const ticker = setInterval(() => {
    for (const { room, msgs, deleted } of rooms.tick()) {
      if (deleted) {
        io.to(room.id).emit('roomClosed', { reason: 'empty' });
        io.in(room.id).disconnectSockets(true);
        hooks.onRoomClosed?.(room);
      } else dispatch(room, msgs);
    }
  }, tickMs);
  ticker.unref?.();

  return {
    dispatch,
    closeRoom,
    kickUser(roomId, userId) {
      const room = rooms.get(roomId);
      if (!room) return false;
      const res = room.kick(null, userId, { byPanel: true });
      if (res.error) return false;
      dispatch(room, res.msgs);
      if (res.kickedSocketId) dropSocket(res.kickedSocketId, 'kicked');
      return true;
    },
    broadcastPublicUrl(url) {
      io.emit('publicUrl', url);
    },
    stop() {
      clearInterval(ticker);
      for (const t of usersTimers.values()) clearTimeout(t);
    },
  };
}
