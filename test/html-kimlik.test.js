import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Aynı id iki öğede olunca $('#…') yalnız ilkini buluyor: ikinci ayar sessizce birinciyi değiştiriyordu
// (önbellek boyutu alanı "Önünü hazırla" ile aynı id'yi almıştı).
for (const sayfa of ['public/room.html', 'masaustu/electron/acilis.html']) {
  test(`${sayfa}: aynı id iki kez kullanılmıyor`, () => {
    const ids = [...fs.readFileSync(sayfa, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((x, i) => ids.indexOf(x) !== i), []);
  });
}

// Sayfaya gömülü <script> kodunda tek söz dizimi hatası bütün sayfayı durduruyor (açılış ekranında
// tırnak hatası "Film ara ve oda aç" düğmesini, adı, kaliteyi birlikte bozmuştu).
const sayfalar = [
  ...fs.readdirSync('public').filter((f) => f.endsWith('.html')).map((f) => `public/${f}`),
  ...fs.readdirSync('panel').filter((f) => f.endsWith('.html')).map((f) => `panel/${f}`),
  ...fs.readdirSync('masaustu/electron').filter((f) => f.endsWith('.html')).map((f) => `masaustu/electron/${f}`),
];
for (const sayfa of sayfalar) {
  test(`${sayfa}: gömülü kod derleniyor`, async () => {
    const vm = await import('node:vm');
    const html = fs.readFileSync(sayfa, 'utf8');
    for (const [, nitelik, kod] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc=/.test(nitelik) || /type=["']module["']/.test(nitelik) || !kod.trim()) continue;
      assert.doesNotThrow(() => new vm.Script(kod), `${sayfa} gömülü kod hatası`);
    }
  });
}
