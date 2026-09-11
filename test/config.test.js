import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, validateConfig, createConfigStore } from '../src/config.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-config-'));
  return path.join(dir, 'config.json');
}

test('validateConfig accepts defaults', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
});

test('validateConfig trims nickname and normalizes addons', () => {
  const cfg = validateConfig({
    ...DEFAULT_CONFIG,
    nickname: '  recep  ',
    addons: [{ url: 'https://torrentio.strem.fun/manifest.json', name: 'Torrentio', enabled: true, resources: ['stream'] }],
  });
  assert.equal(cfg.nickname, 'recep');
  assert.equal(cfg.addons[0].name, 'Torrentio');
});

test('validateConfig rejects bad values with messages', () => {
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, nickname: '' }),
    /nickname/,
  );
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, addons: [{ url: 'ftp://x/manifest.json', name: 'x', enabled: true, resources: [] }] }),
    /addons\[0\]\.url/,
  );
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, addons: [{ url: 'https://x.com/other.json', name: 'x', enabled: true, resources: [] }] }),
    /manifest\.json/,
  );
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults, waitMode: 'maybe' } }),
    /waitMode/,
  );
  assert.throws(
    () => validateConfig({ ...DEFAULT_CONFIG, defaults: { ...DEFAULT_CONFIG.defaults, relayLimit: 99 } }),
    /relayLimit/,
  );
});

test('validateConfig drops unknown resources', () => {
  const cfg = validateConfig({
    ...DEFAULT_CONFIG,
    addons: [{ url: 'https://a.com/manifest.json', name: 'a', enabled: true, resources: ['stream', 'catalog'] }],
  });
  assert.deepEqual(cfg.addons[0].resources, ['stream']);
});

test('store returns defaults when file missing and persists saves', () => {
  const file = tmpFile();
  const store = createConfigStore(file);
  assert.deepEqual(store.get(), DEFAULT_CONFIG);
  store.save({ ...DEFAULT_CONFIG, nickname: 'ali' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nickname, 'ali');
  assert.equal(createConfigStore(file).get().nickname, 'ali');
});

test('store backs up a corrupt file and falls back to defaults', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const store = createConfigStore(file);
  assert.deepEqual(store.get(), DEFAULT_CONFIG);
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('config.json.bozuk-'));
  assert.equal(backups.length, 1);
});

test('store.get returns a copy', () => {
  const store = createConfigStore(tmpFile());
  store.get().nickname = 'changed';
  assert.equal(store.get().nickname, DEFAULT_CONFIG.nickname);
});
