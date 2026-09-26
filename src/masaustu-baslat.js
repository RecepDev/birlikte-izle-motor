// Masaüstü istemcisini bu makinede başlatır.
//
// Stremio, addon'un verdiği adresi https:// diye yeniden yazıyor; bu yüzden
// "birlikteizle://" şeması Stremio'dan çalışmıyor. Çözüm: Stremio sıradan bir
// http adresi açıyor, sunucu da uygulamayı kendisi başlatıyor.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BURASI = path.dirname(fileURLToPath(import.meta.url));

// Uygulama şemayı kendine kaydettiği için kayıt defteri, kurulum yerini bilmenin
// en güvenilir yolu: kullanıcı uygulamayı nereye koyarsa koysun buluyoruz.
function kayittanBul() {
  if (process.platform !== 'win32') return null;
  try {
    const cikti = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\birlikteizle\\shell\\open\\command', '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const eslesme = cikti.match(/"([^"]+\.exe)"/i);
    return eslesme?.[1] || null;
  } catch {
    return null;
  }
}

export function masaustuYolu() {
  const adaylar = [
    process.env.BIRLIKTE_MASAUSTU,
    kayittanBul(),
    path.join(BURASI, '..', 'masaustu', 'dagitim', 'Birlikte Izle-win32-x64', 'Birlikte Izle.exe'),
  ].filter(Boolean);
  for (const aday of adaylar) if (fs.existsSync(aday)) return aday;
  return null;
}

// Uygulamayı verilen adresle açar. Açıksa ikinci örnek kapanıp çalışan pencereyi
// o adrese yolluyor (bkz. masaustu/electron/ana.cjs).
export function masaustuAc(url) {
  const exe = masaustuYolu();
  if (!exe) return { error: 'yok' };
  // ELECTRON_RUN_AS_NODE ortamda kalmışsa uygulama Electron yerine düz Node gibi
  // açılıp hemen kapanıyor; miras almasını engelliyoruz.
  const ortam = { ...process.env };
  delete ortam.ELECTRON_RUN_AS_NODE;
  const cocuk = spawn(exe, [url], { detached: true, stdio: 'ignore', windowsHide: false, env: ortam });
  cocuk.unref();
  return { ok: true, exe };
}
