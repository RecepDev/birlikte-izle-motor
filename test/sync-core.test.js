import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedPosition,
  estimateClockOffset,
  driftAction,
} from '../public/js/shared/sync-core.js';

test('expectedPosition: paused returns stored position', () => {
  const pb = { paused: true, position: 42, updatedAt: 1000 };
  assert.equal(expectedPosition(pb, 99999), 42);
});

test('expectedPosition: playing advances with server time', () => {
  const pb = { paused: false, position: 10, updatedAt: 1000 };
  assert.equal(expectedPosition(pb, 4000), 13);
});

test('expectedPosition: never negative', () => {
  const pb = { paused: false, position: 0, updatedAt: 5000 };
  assert.equal(expectedPosition(pb, 1000), 0);
});

test('estimateClockOffset uses the lowest-RTT sample', () => {
  const samples = [
    { sent: 0, received: 400, server: 10300 }, // rtt 400, offset 10300-200 = 10100
    { sent: 1000, received: 1040, server: 11020 }, // rtt 40, offset 11020-1020 = 10000
    { sent: 2000, received: 2200, server: 12200 }, // rtt 200, offset 12200-2100 = 10100
  ];
  assert.equal(estimateClockOffset(samples), 10000);
});

test('estimateClockOffset returns 0 for no samples', () => {
  assert.equal(estimateClockOffset([]), 0);
});

test('driftAction: large drift seeks', () => {
  assert.deepEqual(driftAction(2, 1), { type: 'seek' });
  assert.deepEqual(driftAction(-1.6, 1), { type: 'seek' });
});

test('driftAction: medium drift nudges rate toward expected', () => {
  assert.deepEqual(driftAction(0.8, 1), { type: 'rate', rate: 0.95 });
  assert.deepEqual(driftAction(-0.8, 1), { type: 'rate', rate: 1.05 });
});

test('driftAction: small drift restores normal rate', () => {
  assert.deepEqual(driftAction(0.1, 1.05), { type: 'rate', rate: 1 });
  assert.deepEqual(driftAction(0.1, 1), { type: 'none' });
});
