import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/log.js';

test('logger keeps the last N entries in memory', () => {
  const log = createLogger({ keep: 3, echo: false });
  for (let i = 0; i < 5; i++) log.info(`m${i}`);
  assert.deepEqual(log.recent().map((e) => e.msg), ['m2', 'm3', 'm4']);
  assert.equal(log.recent()[0].level, 'info');
});

test('logger writes lines to file and rotates when too big', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-log-'));
  const file = path.join(dir, 'logs', 'server.log');
  const log = createLogger({ file, maxBytes: 200, echo: false });
  for (let i = 0; i < 20; i++) log.error('hata', { i });
  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(file).size <= 400);
  assert.match(fs.readFileSync(file, 'utf8'), /ERROR hata \{"i":\d+\}/);
});
