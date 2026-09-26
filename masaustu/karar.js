// Prototipin saf karar mantığı: mpv'den okunan duruma bakıp ne yapılacağını söyler.
// mpv'ye de sokete de dokunmaz, bu yüzden testlenebilir.

import { expectedPosition, driftAction, SEEK_THRESHOLD } from '../public/js/shared/sync-core.js';

export const AUTO_SEEK_COOLDOWN_MS = 4000;

// Oda kilitliyken oynatmayı yalnızca host kontrol eder (bkz. rooms.js control()).
export const canControl = (settings, userId, hostUserId) => !settings?.locked || userId === hostUserId;

// mpv'nin durumunu odanın anladığı duruma çevirir (bkz. rooms.js USER_STATES).
export function statusState({ loaded, idle, cacheStalled }) {
  if (!loaded) return 'loading';
  if (cacheStalled || idle) return 'buffering';
  return 'ready';
}

// Odanın oynatma durumu ile mpv'nin bulunduğu yeri karşılaştırır.
// local: { position, paused, rate, seeking, ready }
export function syncAction(playback, local, serverNow, lastSeekAt = 0, now = Date.now()) {
  if (!playback || !local.ready) return { type: 'none' };
  const target = expectedPosition(playback, serverNow);
  const diff = local.position - target;

  if (playback.paused) {
    if (!local.paused) return { type: 'pause', position: target };
    if (Math.abs(diff) > 0.3) return { type: 'seek', position: target };
    if (local.rate !== 1) return { type: 'rate', rate: 1 };
    return { type: 'none', drift: diff };
  }
  if (local.paused) return { type: 'play' };
  if (local.seeking) return { type: 'none', drift: diff };

  // Büyük sapmada sarmak gerekir ama art arda sarma izlemeyi bozar, bu yüzden bekleme süresi var.
  if (Math.abs(diff) > SEEK_THRESHOLD) {
    if (now - lastSeekAt < AUTO_SEEK_COOLDOWN_MS) return { type: 'none', drift: diff };
    return { type: 'seek', position: target };
  }
  const action = driftAction(diff, local.rate);
  return action.type === 'none' ? { type: 'none', drift: diff } : { ...action, drift: diff };
}
