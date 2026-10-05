# Canli yayin uctan uca testi. Kullanicinin sunucusuna/istemcisine/Stremio'suna dokunmaz:
# ayri port (7200), gecici kullanici klasorleri; sonunda yalniz test sureclerini kapatir.
# Gerekli: bu klasorde test.mp4 (sesli, 2+ dk; ornek: ffmpeg -f lavfi -i testsrc2=s=1280x720:r=30:d=150 -f lavfi -i sine=frequency=440:duration=150,volume=0.08 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest test.mp4)
# Kullanim: powershell -File scripts\yayin-e2e\calistir.ps1 [-Kalite 1080p30] [-SureMs 55000]
param([string]$Kalite = "1080p30", [int]$SureMs = 55000, [string]$Dosya = "test.mp4")
$ErrorActionPreference = "Continue"
$d = $PSScriptRoot
Set-Location (Join-Path $PSScriptRoot "..\..")
$sunucu = Start-Process node -ArgumentList "scripts/yayin-test-sunucu.mjs", "`"$d\$Dosya`"", "7200" -PassThru -NoNewWindow -RedirectStandardOutput "$d\sunucu.out" -RedirectStandardError "$d\sunucu.err"
$urls = $null
for ($i = 0; $i -lt 40 -and -not $urls; $i++) { Start-Sleep -Milliseconds 250; $l = Get-Content "$d\sunucu.out" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($l) { $urls = $l | ConvertFrom-Json } }
if (-not $urls) { "SUNUCU ACILMADI"; Get-Content "$d\sunucu.err"; exit 1 }
$env:ELECTRON_RUN_AS_NODE = $null
$e = (Resolve-Path "masaustu\node_modules\electron\dist\electron.exe").Path
$env:ODA_URL = $urls.hostUrl; $env:MPV_YOLU = (Resolve-Path "masaustu\mpv\mpv.exe").Path
$env:SONUC_HOST = "$d\host.json"; $env:SURE_MS = "$SureMs"; $env:KALITE = $Kalite
$env:ODA_IZLEYICI = $urls.odaUrl; $env:SONUC_IZLEYICI = "$d\izleyici.json"
Remove-Item "$d\host.json", "$d\izleyici.json" -ErrorAction SilentlyContinue
$env:KABUK_DEBUG = "1"
$h = Start-Process $e -ArgumentList "`"$d\host.cjs`"" -PassThru -RedirectStandardOutput "$d\host.out" -RedirectStandardError "$d\host.err"
# Izleyici yayin acildiktan SONRA girsin (yayin acikken girince dogrudan yayina girmeli)
for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 500; $hj = Get-Content "$d\host.json" -Raw -ErrorAction SilentlyContinue; if ($hj -match 'yayin basladi') { break } }
Start-Sleep -Seconds 2
$v = Start-Process $e -ArgumentList "`"$d\izleyici.cjs`"" -PassThru
$v.WaitForExit(150000) | Out-Null
$h.WaitForExit(150000) | Out-Null
Stop-Process -Id $sunucu.Id -Force -ErrorAction SilentlyContinue
# yalniz test surecleri: gelistirme electron'u ve test mpv'si (kullanicinin istemcisi ayri klasorde)
Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -and $_.CommandLine -match 'yayin-e2e') -or ($_.Name -eq 'mpv.exe' -and $_.ExecutablePath -eq $env:MPV_YOLU) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$H = Get-Content "$d\host.json" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue | ConvertFrom-Json
$V = Get-Content "$d\izleyici.json" -Raw -Encoding UTF8 -ErrorAction SilentlyContinue | ConvertFrom-Json
"===== HOST ($Kalite) ====="
$H.adimlar | ForEach-Object { "  - $_" }
if ($H.oynatici) { "  oynatici: paused=$($H.oynatici.paused) src=$($H.oynatici.src)" }
if ($H.uyarilar) { "  uyarilar: $($H.uyarilar -join ' | ')" }
if ($H.konsol) { "  konsol:"; $H.konsol | Select-Object -First 8 | ForEach-Object { "    $_" } }
$H.durumlar | Select-Object -Last 3 | ForEach-Object { "  durum: $($_.yazi) oynuyor=$($_.oynuyor) t=$($_.t) bekleme=$($_.bekleme)" }
"===== IZLEYICI ====="
$V.adimlar | ForEach-Object { "  - $_" }
if ($V.olcum) { $V.olcum.PSObject.Properties | ForEach-Object { "  $($_.Name): $($_.Value)" } }
