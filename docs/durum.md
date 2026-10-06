# Durum — Motor kopyası

Son güncelleme: 2026-10-06 · Son commit: d72779e · Masaüstü 0.7.37 · Android 0.32.0 (versionCode 32)

## Biten
- Motor seçimi: TorrServer (ölçüm `deneme/motor/olc2.mjs`; ayrıntı `docs/stremiosuz-plan.md`).
- Sunucu, masaüstü ve telefon Stremio'suz çalışabiliyor (11470 taklidi).
- Disk önbelleği + elle boyut: oda ayarlarında (host), masaüstü açılış ekranında, telefon ana ekranında. 0 = kapalı.
- Panel motor durumunu gösteriyor; "uygulamayı aç" kurulu uygulama yoksa kaynak klasörden açıyor.
- **Panelde Motor kartı:**
  - Yeniden başlatma düğmesi (yalnız TorrServer'da).
  - Önbellek doluluğu ve temizleme düğmesi.
  - Açık torrent'ler: peer sayısı, indirme/yükleme hızı, kapatma düğmesi. Odada izlenen torrent kapatılamaz.
  - Motor seçimi (`data/motor.json`, sunucu yeniden açılınca geçerli; `MOTOR` ortam değişkeni varsa o kazanır).
  - Bekçi: TorrServer çökerse kendini yeniden açar. Varsayılan kapalı.
- **Masaüstü açılış ekranı:**
  - Motor rozeti: kendi TorrServer'ı / sunucunun motoru / Stremio / açılıyor / yok.
  - Bekçi anahtarı (varsayılan kapalı).
  - Motor açılırken önbellek alanı artık yanlışlıkla "sunucunun önbelleği" demiyor.
- **Hız:**
  - Peer portu sabit (`data/torrserver/peer-port.txt`). UPnP yönlendirmesi ve DHT'de duyurulan adres yeniden açılışta eskimiyor.
  - TorrServer'ın eski varsayılan tracker listesi güncel listeyle değişti (ngosang + sabit iyi liste).
  - Metadata yoklaması 300 ms'den 100 ms'ye indi.
- **Düzeltme:** TorrServer'da ayar yazmak bütün torrent'leri kapatıyor (`SetSettings` → `dropAllTorrent`).
  - Ayar artık yalnız değiştiyse yazılıyor.
  - İzleme sırasında istenen yükleme sınırı torrent kalmayınca uygulanıyor; önceden oynatma kopuyordu.
  - TorrServer modunda "Windows onayı" uyarısı çıkmıyor.
- `npm test` 207/207 (yeni: `test/motor-yonetim.test.js`). e2e 24/24 (TorrServer). Panel uçları yalıtılmış sunucuda denendi.
- Kurulum dosyaları: `D:\Botlar\Kurulumlar\BirlikteIzleMotor-Kurulum-0.7.36.exe`, `BirlikteIzleMotor-Android-0.32.0.apk`. 0.7.37 masaüstüne sunucudan otomatik güncellemeyle gidiyor.

## Bekleyen
- APK gerçek telefonda denenmedi. Telefonun motorunda (`Motor.kt`) sabit port ve tracker listesi yok.
- Kullanıcıyla Stremio kapalıyken gerçek izleme denemesi yapılmadı.
- Tarayıcı uyumluluk modu (Stremio hlsv2 dönüştürücüsü) TorrServer modunda yok.
- Arayüzde ~78 kullanıcıya görünen "Stremio" yazısı kaldı (Faz 5).
- Açılış hızı ölçümde Stremio'nun gerisinde (medyan 12.9 sn, Stremio 4.1 sn). Yeni ayarlarla yeniden ölçülmedi (`deneme/motor/olc2.mjs`).
- Windows güvenlik duvarı açık olan bilgisayarlarda TorrServer'a gelen bağlantı kuralı yok (bu bilgisayarda duvar kapalı).

## Bilinen tuzaklar
- Windows'ta Stremio `::` üzerinde dinlerken 127.0.0.1'e bağlanmak yine başarılı oluyor ve trafiği Stremio alıyor. Taklit bu yüzden `::` üzerinde dinleyip kimlik kontrolü yapıyor.
- TorrServer'ın kendi disk önbelleği yeniden açılışta kullanılmıyor; kendi blok önbelleğimiz bu yüzden var.
- TorrServer zorla kapatılırsa süreç sahipsiz kalır: önce `/shutdown`.
- TorrServer'a `/settings set` göndermek açık torrent'leri kapatır. İzleme sırasında ayar yazma.
- Stremio motorunda Stremio asıl Birlikte İzle'yle ortak. Panel orada yeniden başlatma ve torrent kapatma göstermiyor.
