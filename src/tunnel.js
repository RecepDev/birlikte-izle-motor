// Runs a Cloudflare quick tunnel (cloudflared) in front of the public port.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// cloudflared also prints https://api.trycloudflare.com in its error lines; that is not a tunnel.
const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

export function extractTunnelUrl(text) {
  return String(text).match(TUNNEL_URL)?.[0] ?? null;
}

export function findCloudflared({ env = process.env, exists = fs.existsSync } = {}) {
  const candidates = [];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'cloudflared.exe'), path.join(dir, 'cloudflared'));
  }
  candidates.push(
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  );
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
  return candidates.find((p) => exists(p)) || null;
}

export function createTunnel({
  port,
  log,
  spawn = nodeSpawn,
  find = findCloudflared,
  backoffMs = [5_000, 15_000, 60_000],
  onChange = () => {},
}) {
  let status = { state: 'stopped', url: null };
  let current = null;
  let stopping = false;
  let attempt = 0;
  let timer = null;

  function set(next) {
    status = next;
    onChange({ ...status });
  }

  function start() {
    clearTimeout(timer);
    stopping = false;
    const bin = find();
    if (!bin) {
      set({ state: 'missing', url: null });
      return;
    }
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], { windowsHide: true });
    current = child;
    set({ state: 'starting', url: null });

    const onData = (buf) => {
      if (child !== current) return;
      const text = buf.toString();
      for (const line of text.split('\n')) {
        if (/\bERR\b/.test(line)) log.warn(`cloudflared: ${line.trim().slice(0, 300)}`);
      }
      const url = extractTunnelUrl(text);
      if (url && url !== status.url) {
        attempt = 0;
        log.info('Tünel hazır', { url });
        set({ state: 'up', url });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const onEnd = (reason) => {
      if (child !== current) return;
      current = null;
      if (stopping) {
        set({ state: 'stopped', url: null });
        return;
      }
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      attempt++;
      log.warn('Tünel kapandı, yeniden başlatılacak', { reason, waitMs: wait });
      set({ state: 'down', url: null });
      timer = setTimeout(start, wait);
      timer.unref?.();
    };
    child.on('exit', (code) => onEnd(`exit ${code}`));
    child.on('error', (err) => onEnd(err.message));
  }

  function stop() {
    stopping = true;
    clearTimeout(timer);
    if (current) current.kill();
    else set({ state: 'stopped', url: null });
  }

  return {
    start,
    stop,
    restart() {
      stop();
      start();
    },
    status: () => ({ ...status }),
  };
}

export function installCloudflared({ log, spawn = nodeSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(
      'winget',
      ['install', '--id', 'Cloudflare.cloudflared', '-e', '--accept-source-agreements', '--accept-package-agreements'],
      { windowsHide: true },
    );
    const onData = (buf) => {
      const text = buf.toString().trim();
      if (text) log.info(`winget: ${text.slice(0, 300)}`);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      log.error('winget çalıştırılamadı', { error: err.message });
      resolve(-1);
    });
    child.on('exit', (code) => {
      log.info('cloudflared kurulumu bitti', { code });
      resolve(code);
    });
  });
}
