// Stremio'nun yükleme (upload) sınırı: torrent indirirken Stremio başka kişilere de yüklüyor ve
// ev internetinin dar yükleme hattını doldurabiliyor. Hat dolunca evdeki her şeyin bağlantısı
// kopuyor. Stremio'da yükleme sınırı ayarı yok; Windows'un QoS kuralıyla yalnızca
// stremio-runtime.exe'nin gönderdiği trafik sınırlanıyor. Bizim sunucumuzun (node.exe)
// misafirlere aktardığı video bu sınırdan etkilenmiyor. Kural kurmak yönetici izni istiyor
// (Windows onay penceresi çıkar); okumak istemiyor.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const AD = 'BirlikteIzleStremio';
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// Şu anki sınır (Mbps) ya da null (sınır yok).
export async function sinirOku() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run('powershell.exe', [...PS,
      `(Get-NetQosPolicy -Name '${AD}' -ErrorAction SilentlyContinue).ThrottleRate`], { timeout: 15_000, windowsHide: true });
    const bit = Number(String(stdout).trim());
    return bit > 0 ? Math.round(bit / 1e5) / 10 : null;
  } catch {
    return null;
  }
}

// mbps: sayı (sınır koy) ya da null (kaldır). Yönetici onayı penceresi açılır.
export async function sinirKoy(mbps) {
  if (process.platform !== 'win32') return { error: 'desteklenmiyor' };
  const kaldir = `Remove-NetQosPolicy -Name '${AD}' -Confirm:$false -ErrorAction SilentlyContinue`;
  const koy = mbps
    ? `; New-NetQosPolicy -Name '${AD}' -AppPathNameMatchCondition 'stremio-runtime.exe' -ThrottleRateActionBitsPerSecond ${Math.round(mbps * 1e6)} -NetworkProfile All | Out-Null`
    : '';
  const ic = `${kaldir}${koy}`.replace(/'/g, "''");
  try {
    await run('powershell.exe', [...PS,
      `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','${ic}'`],
    { timeout: 120_000, windowsHide: true });
  } catch {
    return { error: 'izinYok' }; // onay penceresinde "Hayır" denildi
  }
  const simdi = await sinirOku();
  return (mbps ? simdi !== null : simdi === null) ? { ok: true, mbps: simdi } : { error: 'izinYok' };
}
