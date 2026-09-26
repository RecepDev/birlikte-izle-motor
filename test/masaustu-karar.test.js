import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncAction, statusState, canControl, AUTO_SEEK_COOLDOWN_MS } from '../masaustu/karar.js';

const NOW = 1_000_000;
const playing = { paused: false, position: 100, updatedAt: NOW };
const paused = { paused: true, position: 100, updatedAt: NOW };
const at = (position, extra = {}) => ({ position, paused: false, rate: 1, seeking: false, ready: true, ...extra });

test('oda oynuyor ve konum tutuyorsa hiçbir şey yapılmaz', () => {
  const action = syncAction(playing, at(100), NOW);
  assert.equal(action.type, 'none');
  assert.equal(action.drift, 0);
});

test('sapma küçükken hız ayarlanır, sarma yapılmaz', () => {
  assert.deepEqual(syncAction(playing, at(100.6), NOW).type, 'rate');
  assert.equal(syncAction(playing, at(100.6), NOW).rate, 0.95); // ileride: yavaşla
  assert.equal(syncAction(playing, at(99.4), NOW).rate, 1.05); // geride: hızlan
});

test('hız düzeltmesi bittiğinde 1e döner', () => {
  assert.deepEqual(syncAction(playing, at(100, { rate: 0.95 }), NOW), { type: 'rate', rate: 1, drift: 0 });
});

test('sapma büyükse sarılır, ama art arda sarma bekleme süresiyle engellenir', () => {
  const far = at(140);
  assert.equal(syncAction(playing, far, NOW).type, 'seek');
  const tooSoon = syncAction(playing, far, NOW, NOW - 1000, NOW);
  assert.equal(tooSoon.type, 'none');
  const afterCooldown = syncAction(playing, far, NOW, NOW - AUTO_SEEK_COOLDOWN_MS - 1, NOW);
  assert.equal(afterCooldown.type, 'seek');
});

test('oda ilerledikçe hedef konum da ilerler', () => {
  // Oda 10 sn önce 100. saniyeden başlattıysa şimdi 110'da olmalı.
  const action = syncAction(playing, at(110), NOW + 10_000);
  assert.equal(action.type, 'none');
  assert.equal(syncAction(playing, at(100), NOW + 10_000).type, 'seek');
});

test('oda duraklattıysa mpv de duraklatılır ve konum hizalanır', () => {
  assert.deepEqual(syncAction(paused, at(100), NOW), { type: 'pause', position: 100 });
  const already = syncAction(paused, at(105, { paused: true }), NOW);
  assert.deepEqual(already, { type: 'seek', position: 100 });
  assert.deepEqual(syncAction(paused, at(100, { paused: true }), NOW), { type: 'none', drift: 0 });
});

test('oda oynuyorsa duraklamış mpv başlatılır', () => {
  assert.deepEqual(syncAction(playing, at(100, { paused: true }), NOW), { type: 'play' });
});

test('mpv sarma yaparken ya da hazır değilken karışılmaz', () => {
  assert.equal(syncAction(playing, at(140, { seeking: true }), NOW).type, 'none');
  assert.deepEqual(syncAction(playing, at(140, { ready: false }), NOW), { type: 'none' });
  assert.deepEqual(syncAction(null, at(100), NOW), { type: 'none' });
});

test('durum, odanın anladığı kelimelere çevrilir', () => {
  assert.equal(statusState({ loaded: false, idle: true, cacheStalled: false }), 'loading');
  assert.equal(statusState({ loaded: true, idle: false, cacheStalled: true }), 'buffering');
  assert.equal(statusState({ loaded: true, idle: true, cacheStalled: false }), 'buffering');
  assert.equal(statusState({ loaded: true, idle: false, cacheStalled: false }), 'ready');
});

test('kilitli odada yalnızca host kontrol eder', () => {
  assert.equal(canControl({ locked: true }, 'u1', 'host'), false);
  assert.equal(canControl({ locked: true }, 'host', 'host'), true);
  assert.equal(canControl({ locked: false }, 'u1', 'host'), true);
  assert.equal(canControl(undefined, 'u1', 'host'), true);
});
