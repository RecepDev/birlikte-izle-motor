import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Aynı id iki öğede olunca $('#…') yalnız ilkini buluyor: ikinci ayar sessizce birinciyi değiştiriyordu
// (önbellek boyutu alanı "Önünü hazırla" ile aynı id'yi almıştı).
for (const sayfa of ['public/room.html', 'masaustu/electron/baslangic.html']) {
  test(`${sayfa}: aynı id iki kez kullanılmıyor`, () => {
    const ids = [...fs.readFileSync(sayfa, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
  });
}
