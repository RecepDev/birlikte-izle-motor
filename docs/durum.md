# Durum — Motor kopyası

Son güncelleme: 2026-10-06 · Son commit: a59453a · Masaüstü 0.7.37 · Android 0.33.0 (versionCode 33)

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
  - "Film ara ve oda aç" düğmesi: sunucu uygulamadan sonra açılırsa da 5 sn içinde görünüyor.
- **Hız:**
  - Peer portu sabit (`data/torrserver/peer-port.txt`). UPnP yönlendirmesi ve DHT'de duyurulan adres yeniden açılışta eskimiyor.
  - TorrServer'ın eski varsayılan tracker listesi güncel listeyle değişti (ngosang + sabit iyi liste).
  - Metadata yoklaması 300 ms'den 100 ms'ye indi.
  - Okuyan kalmayan torrent 30 sn yerine 2 dk sonra kapanıyor (duraklatıp dönünce peer'ler sıfırlanmasın).
  - Günlükte her yeni torrent için "Torrent açılışı" satırı var: `metadataSn` ve `ilkVeriSn`.
  - Oda: video hiç başlamadı ve veri gelmiyorsa, ölçülmüş iyi kaynağa 15 sn'de geçiliyor (eskisi 45 sn).
  - Önden okuma %95 → %10 (≈51 MB). Ölçümde sıralı izleme 25.5 → 44.8 Mbps (`docs/stremiosuz-plan.md` "üçüncü tur"). uTP açık kaldı.
  - Telefon (APK 0.33.0): önden okuma ≈51 MB, boşta kapanma 2 dk, güncel tracker listesi.
- **Düzeltme:** TorrServer'da ayar yazmak bütün torrent'leri kapatıyor (`SetSettings` → `dropAllTorrent`).
  - Ayar artık yalnız değiştiyse yazılıyor.
  - İzleme sırasında istenen yükleme sınırı torrent kalmayınca uygulanıyor; önceden oynatma kopuyordu.
  - TorrServer modunda "Windows onayı" uyarısı çıkmıyor.
- `npm test` 214/214 (yeni: `test/motor-yonetim.test.js`; `html-kimlik.test.js` sayfalardaki gömülü kodu derliyor). e2e 24/24 (TorrServer). Panel uçları yalıtılmış sunucuda denendi.
- Kurulum dosyaları: `D:\Botlar\Kurulumlar\BirlikteIzleMotor-Kurulum-0.7.36.exe`, `BirlikteIzleMotor-Android-0.33.0.apk`. Masaüstü 0.7.37 sunucudan otomatik güncellemeyle gidiyor.

## Bekleyen
- APK gerçek telefonda denenmedi. Telefonda sabit peer portu yok (mobil ağda UPnP işe yaramıyor).
- Kullanıcıyla Stremio kapalıyken gerçek izleme denemesi yapılmadı.
- Tarayıcı uyumluluk modu (Stremio hlsv2 dönüştürücüsü) TorrServer modunda yok.
- Arayüzde ~78 kullanıcıya görünen "Stremio" yazısı kaldı (Faz 5).
- Açılış: TorrServer medyanı 7.6 sn (önceki tur 12.9; Stremio o turda 4.1). Bunun 4–5 sn'si metadata.
- Film bilgisini (metadata) diskte saklama ve itorrents gibi bir siteden isteme yapılmadı. İkincisi gizlilik yüzünden kullanıcı onayı bekliyor.
- Windows güvenlik duvarı açık olan bilgisayarlarda TorrServer'a gelen bağlantı kuralı yok (bu bilgisayarda duvar kapalı).

## Bilinen tuzaklar
- Windows'ta Stremio `::` üzerinde dinlerken 127.0.0.1'e bağlanmak yine başarılı oluyor ve trafiği Stremio alıyor. Taklit bu yüzden `::` üzerinde dinleyip kimlik kontrolü yapıyor.
- TorrServer'ın kendi disk önbelleği yeniden açılışta kullanılmıyor; kendi blok önbelleğimiz bu yüzden var.
- TorrServer zorla kapatılırsa süreç sahipsiz kalır: önce `/shutdown`.
- TorrServer'a `/settings set` göndermek açık torrent'leri kapatır. İzleme sırasında ayar yazma.
- Kurulumsuz kısayol (`masaustu` içinde electron.exe) kaynak dosyaları doğrudan çalıştırır: açılış ekranındaki hata hemen ona yansır. d72779e'de bir tırnak hatası bütün ekran kodunu durdurmuştu.
- Stremio motorunda Stremio asıl Birlikte İzle'yle ortak. Panel orada yeniden başlatma ve torrent kapatma göstermiyor.
