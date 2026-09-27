// mpv'yi başlatır ve JSON IPC ile konuşur (Windows'ta adlandırılmış boru).
// Protokol: her istek tek satır JSON, cevap aynı request_id ile geri gelir.
// Olaylar (property değişimi, dosya bitti…) request_id taşımaz, dinleyicilere dağıtılır.

import { spawn } from 'node:child_process';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const CONNECT_RETRY_MS = 120;
const CONNECT_TIMEOUT_MS = 10_000;

// mpv bir süre soketi açmıyor; açılana kadar deneriz.
function connect(pipePath, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(pipePath);
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error('mpv IPC açılmadı'));
        else setTimeout(attempt, CONNECT_RETRY_MS);
      });
    };
    attempt();
  });
}

export function createMpv({ binary = 'mpv', pipeName = 'birlikte-izle', args = [], spawnFn = spawn } = {}) {
  const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : `/tmp/${pipeName}.sock`;
  const events = new EventEmitter();
  const pending = new Map();
  let socket = null;
  let child = null;
  let nextId = 1;
  let buffer = '';

  function handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // mpv bazen IPC olmayan metin de yazar
    }
    if (msg.request_id !== undefined && pending.has(msg.request_id)) {
      const { resolve, reject } = pending.get(msg.request_id);
      pending.delete(msg.request_id);
      if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
      else resolve(msg.data);
      return;
    }
    if (msg.event) events.emit(msg.event, msg);
  }

  async function start() {
    child = spawnFn(binary, [
      `--input-ipc-server=${pipePath}`,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=yes',
      ...args,
    ], { stdio: 'ignore' });
    child.once('exit', (code) => events.emit('exit', code));
    socket = await connect(pipePath);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    });
    socket.on('error', () => {});
    return api;
  }

  // command('seek', 10) ya da adlandırılmış argümanlı komutlar için
  // command({ name: 'osd-overlay', id: 1, … }).
  function command(...parts) {
    if (!socket) return Promise.reject(new Error('mpv bağlı değil'));
    const id = nextId++;
    const komut = parts.length === 1 && typeof parts[0] === 'object' ? parts[0] : parts;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(`${JSON.stringify({ command: komut, request_id: id })}\n`);
    });
  }

  const api = {
    pipePath,
    start,
    command,
    get: (name) => command('get_property', name),
    set: (name, value) => command('set_property', name, value),
    // Property değişimlerini 'property-change' olayı olarak akıtır.
    observe: (id, name) => command('observe_property', id, name),
    load: (url) => command('loadfile', url, 'replace'),
    seek: (position) => command('seek', position, 'absolute'),
    // Düz metin komut satırı: ';' ile ayrılan komutlar mpv'de aynı turda işlenir, arada
    // kare çizilmez (birkaç ayarı tek seferde değiştirmek için). Cevap beklenmez.
    raw: (line) => socket?.write(`${line}\n`),
    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),
    async stop() {
      try {
        await command('quit');
      } catch { /* zaten kapanmış olabilir */ }
      socket?.destroy();
      child?.kill();
    },
  };
  return api;
}
