# Birlikte İzle — Motor (Stremio'suz kopya)

Birlikte İzle'nin Stremio olmadan çalışan deneme kopyası. Git dalı `motor`.
Asıl (canlı) proje: `D:\Botlar\stremio-birlikte-izle` — kullanıcı onunla izliyor. Stremio'dan ayırma işleri YALNIZ burada yapılır. Kullanıcının canlı uygulamada istediği düzeltmeler asıl projeye gider; gerekirse buraya `git pull` ile alınır.

- Kaldığımız yer: `docs/durum.md`
- Motor kararı, ölçümler, fazlar: `docs/stremiosuz-plan.md`
- Genel tasarım (600 satır, gerekince ilgili bölümü oku): `docs/superpowers/specs/2026-09-11-birlikte-izle-design.md`

## Yapı
Node 20, Express, Socket.IO; tarayıcı JS düz (derleme yok).
Torrent motoru TorrServer (Go). Önünde `src/motor/stremio-taklidi.js` Stremio'nun 127.0.0.1:11470 adreslerini taklit eder; istemciler değişmeden çalışır. `MOTOR=torrserver` (varsayılan) ya da `stremio`; 11470 doluysa (Stremio açık) Stremio'ya düşer. `TEST_INSTANCE` varken varsayılan `stremio`.

Portlar: 7300 herkese açık (oda sayfası, addon, relay; cloudflared tüneli) · 7301 yerel panel · 8097 sunucunun TorrServer'ı · 8098 masaüstü uygulamasının TorrServer'ı · 11470 Stremio taklidi.

## Dosya haritası
- `server.js` — her şeyi bağlar: motor seçimi, oda olayları, panel.
- `src/motor/torrserver.js` — TorrServer'ı indirir/açar/kapatır, HTTP API.
- `src/motor/stremio-taklidi.js` — 11470 taklidi. Dosyayı adla eşler (TorrServer pad dosyalarını listelemez, sıra numarası tutmaz). `::` üzerinde dinler + kimlik kontrolü.
- `src/motor/onbellek.js` — 4 MB bloklu disk önbelleği (en eski kullanılan silinir).
- `src/onbellek-ayar.js` — elle girilen önbellek boyutu (`data/onbellek.json`) + Stremio `cacheSize`.
- `src/rooms.js`, `src/socket.js` — oda durumu, Socket.IO.
- `src/streams.js`, `src/addon.js`, `src/addons-client.js` — kaynak bulma, Stremio addon.
- `src/relay.js` — misafirlere video aktarımı.
- `src/panel-api.js` + `panel/` — yerel panel.
- `src/indir.js` — masaüstü güncelleme listesi `MASAUSTU_DOSYALARI`.
- `src/masaustu-baslat.js` — paneldeki "uygulamayı aç".
- `public/room.html`, `public/js/room.js` (3400 satır — Grep kullan), `public/js/shared/` (sync-core, stream-url: DOM'suz, istemcilerle ortak).
- `masaustu/` — Electron + gömülü mpv. `electron/ana.cjs` ana süreç, `motor-baslat.cjs` 11470 boşsa TorrServer açar, `stremio-vekil.cjs`, `baslangic.html` açılış ekranı, `onyukleme-kabuk.cjs`.
- `android/app/src/main/java/xyz/birlikteizle/mobil/` — Kotlin, Media3. `Motor.kt` (TorrServer + Kotlin taklit + önbellek), `Onbellek.kt`, `OdaActivity.kt`, `MainActivity.kt`.
- `deneme/motor/` — motor karşılaştırma betikleri (ürüne girmez).

## Komutlar
- Birim testleri: `npm test`
- Uçtan uca (gerçek torrent, kendini temizler): `MOTOR=torrserver MOTOR_URL=http://127.0.0.1:11471 npm run e2e`
- Yerel deneme sunucusu: `PUBLIC_PORT=7400 PANEL_PORT=7401 NO_TUNNEL=1 DATA_DIR=<geçici> node server.js`
- Canlı kopya sunucusu: `baslat.vbs` (kısayol "Birlikte Izle Motor"). Yeniden başlatırken eski node sürecini kapat, sahipsiz cloudflared kalmadığını kontrol et.
- Masaüstü kurulum: `cd masaustu && npm run kurulum` → `dagitim-setup\Birlikte Izle Motor Kurulum.exe` → `D:\Botlar\Kurulumlar\BirlikteIzleMotor-Kurulum-<sürüm>.exe`. Kurulumsuz: `npm run paketle` → `dagitim\`.
- Android: `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"` ile `cd android && ./gradlew assembleRelease` → `app/build/outputs/apk/release/app-release.apk` → `Kurulumlar\BirlikteIzleMotor-Android-<sürüm>.apk`.
- Kullanıcıya görünen kopyalar: `Masaüstü\Botlar\Birlikte İzle\Motor (Stremio'suz deneme)\`.

## Kurallar
- Sunucu tarafı değişiklik kullanıcıya ancak sunucu yeniden başlayıp yeni oda açılınca görünür; her seferinde söyle.
- Yeni masaüstü dosyası eklenince `src/indir.js` `MASAUSTU_DOSYALARI`'na ekle (yoksa otomatik güncelleme siler). Yeni motor dosyası `masaustu/motor-kopyala.cjs`'e de girer.
- Sürüm: `masaustu/package.json` version; `android/app/build.gradle.kts` versionCode + versionName.
- Stremio'nun kurulu dosyalarına dokunma.
- Kullanıcının görmediği arka plan torrenti yok (önden yükleme, otomatik tarama yok). Testin açtığı torrentleri kaldır.
- Görüntü kalitesi öncelikli: görüntü yeniden kodlanmaz.
- Hata ayıklarken önce `data/logs/server.log` (son "Birlikte İzle çalışıyor" satırı son commit'ten yeni mi?), oynatma sorunlarında `data/tani/<ODA>.log`.
