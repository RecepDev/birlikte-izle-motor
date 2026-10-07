// Önbellek boyutu (GB, elle giriliyor; 0 = kapalı). TorrServer motorunda bizim video önbelleğimizin
// sınırı (src/motor/onbellek.js), Stremio'da Stremio'nun kendi önbellek ayarı (cacheSize, bayt;
// Stremio'da null = sınırsız). klasor: elle seçilen yer (null = varsayılan data/onbellek; bkz.
// onbellekYeri). data/onbellek.json: { "gb": 10, "klasor": "D:\Onbellek" }

import fs from 'node:fs';
import path from 'node:path';

export const GB = 1024 ** 3;
export const EN_COK_GB = 1000;

export const gecerliGb = (gb) => Number.isFinite(gb) && gb >= 0 && gb <= EN_COK_GB;

export const gecerliKlasor = (k) => k === null || (typeof k === 'string' && k.length < 500 && path.isAbsolute(k));

export function createOnbellekAyar({ file, varsayilanGb = 10, log }) {
  let gb = varsayilanGb;
  let klasor = null;
  try {
    const kayit = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kayitli = Number(kayit.gb);
    if (gecerliGb(kayitli)) gb = kayitli;
    if (kayit.klasor && gecerliKlasor(kayit.klasor)) klasor = kayit.klasor;
  } catch { /* ilk çalıştırma */ }
  function kaydet() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ gb, ...(klasor ? { klasor } : {}) }));
    } catch (err) {
      log.warn('Önbellek ayarı yazılamadı', { error: err.message });
    }
  }
  return {
    gb: () => gb,
    klasor: () => klasor,
    ayarla(yeni) {
      if (!gecerliGb(yeni)) return false;
      gb = yeni;
      kaydet();
      return true;
    },
    klasorAyarla(yeni) {
      if (yeni === '') yeni = null;
      if (!gecerliKlasor(yeni)) return false;
      klasor = yeni;
      kaydet();
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
