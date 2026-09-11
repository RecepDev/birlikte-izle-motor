// Pure sync math shared by the browser and the tests.

export const SEEK_THRESHOLD = 1.5; // seconds
export const RATE_THRESHOLD = 0.3; // seconds
export const SLOW_RATE = 0.95;
export const FAST_RATE = 1.05;

// Where the room's video should be right now, in seconds.
export function expectedPosition(playback, serverNow) {
  if (playback.paused) return playback.position;
  return Math.max(0, playback.position + (serverNow - playback.updatedAt) / 1000);
}

// samples: [{ sent, received, server }] in ms. Returns serverClock - clientClock
// taken from the sample with the lowest round trip.
export function estimateClockOffset(samples) {
  if (!samples.length) return 0;
  let best = samples[0];
  for (const s of samples) {
    if (s.received - s.sent < best.received - best.sent) best = s;
  }
  const midpoint = best.sent + (best.received - best.sent) / 2;
  return best.server - midpoint;
}

// diff = actualPosition - expectedPosition (seconds).
export function driftAction(diff, currentRate) {
  const abs = Math.abs(diff);
  if (abs > SEEK_THRESHOLD) return { type: 'seek' };
  if (abs > RATE_THRESHOLD) return { type: 'rate', rate: diff > 0 ? SLOW_RATE : FAST_RATE };
  if (currentRate !== 1) return { type: 'rate', rate: 1 };
  return { type: 'none' };
}
