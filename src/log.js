import fs from 'node:fs';
import path from 'node:path';

export function createLogger({ file = null, maxBytes = 5 * 1024 * 1024, keep = 100, echo = true } = {}) {
  const recent = [];
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });

  function write(level, msg, data) {
    const entry = { ts: new Date().toISOString(), level, msg, data };
    recent.push(entry);
    if (recent.length > keep) recent.shift();

    const line = `${entry.ts} ${level.toUpperCase()} ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}\n`;
    if (echo) (level === 'error' ? process.stderr : process.stdout).write(line);
    if (!file) return;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size + line.length > maxBytes) {
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, line);
    } catch {
      // Logging must never crash the server.
    }
  }

  return {
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
    recent: () => recent.slice(),
  };
}
