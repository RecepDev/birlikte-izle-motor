import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTani } from '../src/tani.js';

test('tani keeps per-user entries in memory and appends them to the room log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tani-'));
  const tani = createTani({ dir, log: { warn() {} } });
  const room = { id: 'ABC123' };
  const user = { id: 'u1', name: 'Nnje' };
  tani.ekle(room, user, [{ t: 1, k: 'durum', s: 'buffering' }, { bad: true }, { t: 2, k: 'n', ahead: 3 }]);
  assert.equal(tani.oku('ABC123', 'u1').length, 2);
  const lines = fs.readFileSync(path.join(dir, 'ABC123.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Nnje durum \{"s":"buffering"\}/);
  tani.odaKapandi('ABC123');
  assert.deepEqual(tani.oku('ABC123', 'u1'), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
