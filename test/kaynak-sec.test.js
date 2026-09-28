import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otomatikSec } from '../public/js/shared/kaynak-sec.js';

const t = (streamId, quality, seeders, extra = {}) => ({ streamId, kind: 'torrent', quality, seeders, ...extra });

test('otomatikSec: preferred quality, most seeds, packs weighted down', () => {
  const list = [t('a', '1080p', 900), t('b', '2160p', 40), t('c', '2160p', 100, { pack: true }), t('d', '2160p', 60)];
  assert.equal(otomatikSec(list, '2160p').streamId, 'd');
  assert.equal(otomatikSec(list, '1080p').streamId, 'a');
});

test('otomatikSec: falls back to lower, then higher quality when preferred has no usable seeds', () => {
  const list = [t('a', '2160p', 50), t('b', '1080p', 1), t('c', '720p', 30)];
  assert.equal(otomatikSec(list, '1080p').streamId, 'c');
  assert.equal(otomatikSec([t('a', '2160p', 50), t('b', '1080p', 1)], '1080p').streamId, 'a');
});

test('otomatikSec: http only when allowed', () => {
  const list = [t('a', '1080p', 10), { streamId: 'h', kind: 'http', quality: '1080p' }];
  assert.equal(otomatikSec(list, '1080p').streamId, 'a');
  assert.equal(otomatikSec(list, '1080p', { httpOk: true }).streamId, 'h');
  assert.equal(otomatikSec([], '1080p'), null);
});
