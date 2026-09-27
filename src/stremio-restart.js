// Stremio'nun yayın sunucusunu (stremio-runtime.exe server.js, port 11470) yeniden başlatır.
//
// Stremio bazen takılıp hiçbir torrent için hız vermiyor; Stremio'yu kapatıp açmak
// düzeltiyor. Bütün uygulamayı değil, yalnızca yayın sunucusunu yeniden başlatıyoruz:
// Stremio penceresi açık kalıyor, sunucu birkaç saniyede geri geliyor.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function runtimeProcesses() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name='stremio-runtime.exe'\" | "
    + 'Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { windowsHide: true });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// "…\stremio-runtime.exe" C:\…\server.js -> server.js yolu
const serverScript = (commandLine) => commandLine?.match(/stremio-runtime\.exe"?\s+"?([^"]+server\.js)"?/i)?.[1] || null;

// Stremio uygulamasının kurulu olabileceği yerler (Stremio 5 ve 4).
function stremioYolu() {
  const yerel = process.env.LOCALAPPDATA || '';
  const adaylar = [
    path.join(yerel, 'Programs', 'Stremio', 'stremio-shell-ng.exe'),
    path.join(yerel, 'Programs', 'LNV', 'Stremio-4', 'stremio.exe'),
    'C:/Program Files/Stremio/stremio.exe',
  ];
  return adaylar.find((a) => fs.existsSync(a)) || null;
}

// Sunucu açılırken Stremio kapalıysa açar (yayın sunucusu onunla geliyor).
export async function stremioAcikDegilseAc({ stremioLocal, log, platform = process.platform }) {
  if (platform !== 'win32') return;
  if (await stremioLocal.isUp().catch(() => false)) return;
  const exe = stremioYolu();
  if (!exe) {
    log.warn('Stremio kapalı ve kurulu yeri bulunamadı');
    return;
  }
  log.info('Stremio kapalıydı, açılıyor', { exe });
  const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
  child.unref();
}

export function createStremioRestarter({ stremioLocal, log, platform = process.platform }) {
  let busy = null;

  async function waitUntilUp(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await stremioLocal.isUp().catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  async function restart(reason = 'elle') {
    if (platform !== 'win32') return { error: 'unsupported' };
    // Aynı anda iki yeniden başlatma olmasın: ikinci çağrı ilkini bekler.
    if (busy) return busy;
    busy = (async () => {
      const procs = await runtimeProcesses().catch(() => []);
      const proc = procs.find((p) => serverScript(p.CommandLine)) || procs[0];
      if (!proc) return { error: 'notRunning' };
      const exe = proc.ExecutablePath;
      const script = serverScript(proc.CommandLine);
      log.warn('Stremio yayın sunucusu yeniden başlatılıyor', { reason, pid: proc.ProcessId });
      await run('taskkill', ['/PID', String(proc.ProcessId), '/F'], { windowsHide: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
      // Stremio penceresi sunucuyu kendisi geri açabiliyor; açmadıysa biz açıyoruz.
      if (!(await stremioLocal.isUp().catch(() => false)) && exe && script) {
        const child = spawn(exe, [script], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      }
      const up = await waitUntilUp();
      log.info('Stremio yayın sunucusu', { up });
      return up ? { ok: true } : { error: 'notUp' };
    })().finally(() => {
      busy = null;
    });
    return busy;
  }

  return { restart };
}
