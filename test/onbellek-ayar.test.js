import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GB, createOnbellekAyar, gecerliGb, stremioOnbellekOku, stremioOnbellekKoy } from '../src/onbellek-ayar.js';

const sessiz = { info() {}, warn() {}, error() {} };

test('önbellek ayarı: elle girilen GB kaydedilir, geçersizi reddedilir', () => {
  const dosya = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-')), 'onbellek.json');
  const a = createOnbellekAyar({ file: dosya, varsayilanGb: 10, log: sessiz });
  assert.equal(a.gb(), 10);
  assert.equal(a.ayarla(25), true);
  assert.equal(a.ayarla(-1), false);
  assert.equal(a.ayarla(5000), false);
  assert.equal(createOnbellekAyar({ file: dosya, log: sessiz }).gb(), 25);
  assert.equal(gecerliGb(0), true); // 0 = kapalı
});

test('Stremio önbelleği: GB bayta çevrilip Stremio ayarına yazılır, sınırsız null okunur', async () => {
  let ayar = { cacheSize: 2 * GB };
  const sahte = async (url, opt = {}) => {
    if (opt.method === 'POST') ayar = { ...ayar, ...JSON.parse(opt.body) };
    return { ok: true, json: async () => ({ values: ayar }) };
  };
  assert.equal(await stremioOnbellekOku('http://x', sahte), 2);
  const r = await stremioOnbellekKoy('http://x', 7.5, sahte);
  assert.deepEqual(r, { ok: true, gb: 7.5 });
  assert.equal(ayar.cacheSize, Math.round(7.5 * GB));
  ayar.cacheSize = null;
  assert.equal(await stremioOnbellekOku('http://x', sahte), null);
  const kapali = async () => { throw new Error('kapalı'); };
  assert.equal(await stremioOnbellekOku('http://x', kapali), undefined);
  assert.deepEqual(await stremioOnbellekKoy('http://x', 3, kapali), { error: 'stremio' });
});
