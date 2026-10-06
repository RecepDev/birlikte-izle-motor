@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo === Birlikte Izle kurulumu ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. https://nodejs.org adresinden Node.js 20 veya ustunu kur, sonra bu dosyayi tekrar calistir.
  pause
  exit /b 1
)

echo [1/3] Paketler yukleniyor...
call npm install --omit=dev --no-fund --no-audit
if errorlevel 1 (
  echo npm install basarisiz oldu.
  pause
  exit /b 1
)

echo [2/3] cloudflared kontrol ediliyor...
where cloudflared >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files (x86)\cloudflared\cloudflared.exe" goto cf_ok
  echo cloudflared yok, winget ile kuruluyor...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
)
:cf_ok

echo [3/3] Masaustu kisayolu olusturuluyor...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Birlikte Izle Motor.lnk');" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = '\"%~dp0baslat.vbs\"';" ^
  "$s.WorkingDirectory = '%~dp0';" ^
  "$s.IconLocation = 'shell32.dll,238';" ^
  "$s.Description = 'Birlikte Izle Motor paneli (Stremio-suz deneme kopyasi)';" ^
  "$s.Save()"

echo.
echo Kurulum tamam. Masaustundeki "Birlikte Izle" kisayoluyla baslat.
pause
