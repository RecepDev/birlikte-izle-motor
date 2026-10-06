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
    const cikti = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\birlikteizlemotor\\shell\\open\\command', '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const eslesme = cikti.match(/"([^"]+\.exe)"/i);
    return eslesme?.[1] || null;
  } catch {
    return null;
  }
}

// { exe, args } ya da null. Kurulu uygulama yoksa (kurulum hiç açılmadıysa şema kaydı da yok) kaynak
// klasöründen açılıyor: masaustu/node_modules'teki Electron ile ("Kurulumsuz" kısayolunun yaptığı gibi).
export function masaustuYolu() {
  const adaylar = [
    process.env.BIRLIKTE_MOTOR_MASAUSTU,
    kayittanBul(),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'birlikte-izle-motor-masaustu', 'Birlikte Izle Motor.exe'),
    path.join(BURASI, '..', 'masaustu', 'dagitim', 'Birlikte Izle Motor-win32-x64', 'Birlikte Izle Motor.exe'),
  ].filter(Boolean);
  for (const aday of adaylar) if (fs.existsSync(aday)) return { exe: aday, args: [] };
  const kaynak = path.join(BURASI, '..', 'masaustu');
  const electron = path.join(kaynak, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(electron)) return { exe: electron, args: [kaynak] };
  return null;
}

// Uygulamayı verilen adresle açar. Açıksa ikinci örnek kapanıp çalışan pencereyi
// o adrese yolluyor (bkz. masaustu/electron/ana.cjs).
export function masaustuAc(url) {
  const yer = masaustuYolu();
  if (!yer) return { error: 'yok' };
  const { exe, args } = yer;
  // ELECTRON_RUN_AS_NODE ortamda kalmışsa uygulama Electron yerine düz Node gibi
  // açılıp hemen kapanıyor; miras almasını engelliyoruz.
  const ortam = { ...process.env };
  delete ortam.ELECTRON_RUN_AS_NODE;
  // Adres yoksa uygulama açılış ekranıyla (açık odalar, film ara) başlıyor.
  const cocuk = spawn(exe, [...args, ...(url ? [url] : [])], { detached: true, stdio: 'ignore', windowsHide: false, env: ortam });
  cocuk.unref();
  return { ok: true, exe };
}
