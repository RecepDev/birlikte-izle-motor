// Önbellek boyutu (GB, elle giriliyor; 0 = kapalı). TorrServer motorunda bizim video önbelleğimizin
// sınırı (src/motor/onbellek.js), Stremio'da Stremio'nun kendi önbellek ayarı (cacheSize, bayt;
// Stremio'da null = sınırsız). data/onbellek.json: { "gb": 10 }

import fs from 'node:fs';
import path from 'node:path';

export const GB = 1024 ** 3;
export const EN_COK_GB = 1000;

export const gecerliGb = (gb) => Number.isFinite(gb) && gb >= 0 && gb <= EN_COK_GB;

export function createOnbellekAyar({ file, varsayilanGb = 10, log }) {
  let gb = varsayilanGb;
  try {
    const kayitli = Number(JSON.parse(fs.readFileSync(file, 'utf8')).gb);
    if (gecerliGb(kayitli)) gb = kayitli;
  } catch { /* ilk çalıştırma */ }
  return {
    gb: () => gb,
    ayarla(yeni) {
      if (!gecerliGb(yeni)) return false;
      gb = yeni;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ gb }));
      } catch (err) {
        log.warn('Önbellek ayarı yazılamadı', { error: err.message });
      }
      return true;
    },
  };
}

// Stremio'nun önbellek boyutu (GB) ya da null (sınırsız) / undefined (Stremio'ya ulaşılamadı).
export async function stremioOnbellekOku(base, fetchImpl = fetch) {
  try {
    const { values } = await (await fetchImpl(`${base}/settings`, { signal: AbortSignal.timeout(5000) })).json();
    if (!values || !('cacheSize' in values)) return undefined;
    return values.cacheSize === null ? null : Math.round((Number(values.cacheSize) / GB) * 10) / 10;
  } catch {
    return undefined;
  }
}

export async function stremioOnbellekKoy(base, gb, fetchImpl = fetch) {
  if (!gecerliGb(gb)) return { error: 'badValue' };
  try {
    const res = await fetchImpl(`${base}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheSize: Math.round(gb * GB) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { error: 'stremio' };
  } catch {
    return { error: 'stremio' };
  }
  return { ok: true, gb: await stremioOnbellekOku(base, fetchImpl) };
}
