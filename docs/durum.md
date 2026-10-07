# Durum — Motor kopyası

Son güncelleme: 2026-10-07 · Son commit: 48d9405 · Masaüstü 0.7.45 · Android 0.33.0 (versionCode 33)

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
  - Oda: video hiç başlamadı ve 15 sn kesintisiz hiç veri gelmediyse, ölçülmüş iyi kaynağa geçiliyor (eskisi 45 sn).
    - Düzeltme (2026-10-07, Silo odası 86J4BT): veri 12-29 Mbps gelirken iki kaynak arasında 5 sn'de bir 4 kez geçti.
    - Sebep 1: yalnız sunucunun torrent istatistiğine bakıyordu. Artık oynatıcının ölçtüğü hız da sayılıyor (`liveDownload`).
    - Sebep 2: kaynak değişince sayaç sıfırlanmıyordu. Artık sıfırlanıyor.
    - Otomatik geçişten sonra 60 sn yeni geçiş yok. 45 sn'lik zayıf kaynak yolunda da "şimdiki hız" oynatıcının hızını sayıyor.
  - Önden okuma %95 → %10 (≈51 MB). Ölçümde sıralı izleme 25.5 → 44.8 Mbps (`docs/stremiosuz-plan.md` "üçüncü tur"). uTP açık kaldı.
  - Telefon (APK 0.33.0): önden okuma ≈51 MB, boşta kapanma 2 dk, güncel tracker listesi.
  - **Film bilgisi siteden** (`src/motor/torrent-dosyasi.js`, varsayılan açık, kullanıcı istedi): itorrents.net'ten .torrent, kimlik doğrulanıp TorrServer'a yükleniyor, diskte de saklanıyor. Metadata 9.4 sn → 0.26 sn (yeni açılmış TorrServer); itorrents 13 torrent'in 12'sinde vardı. Yalnız sunucuda; masaüstünün kendi motorunda ve telefonda yok.
  - **Hızlı başlat** (masaüstü, varsayılan açık, açılış ekranından kapatılır): mpv 30 sn biriktirmek yerine hız/ihtiyaç ≥2 → 5 sn, ≥1.5 → 10 sn. Gerçek odada veri 36-61 Mbps gelirken video 25 sn sonra başlıyordu. Canlı oynatmada henüz denenmedi.
- Açılış ekranı: oda linki alanı ve "Odaya gir" sağ üstteki ⋮ menüsünde (telefondaki gibi).
- Oda: diyalog açılınca mpv penceresi gizleniyor (sayfanın üstündeki ayrı pencere, diyaloğu örterdi). Video alanı siyah kalmasın diye o anki kare (`screenshot-to-file`, altyazıyla) `<video>`'ya kapak resmi olarak konuyor, diyalog kapanınca kalkıyor (`ana.cjs` `kareGoster`, `onyukleme-kabuk.cjs` `kabuk:kare`). Tuzak: video köprüsü `video.removeAttribute`'u yalnız `src` için tanımlıyor; asıl DOM işlevi `Element.prototype` ile çağrılıyor. Test sunucusu + gerçek kabukla doğrulandı.
- **Sunucu uygulamanın içinde (Kurulumsuz):**
  - Açılış ekranında "🖥️ Sunucuyu başlat" / "🛠️ Sunucu paneli". Sunucu kapalıysa uygulama `node server.js`'i arka planda açar (uygulama kapansa da çalışır; panelde ⏻ Kapat).
  - Panel aynı pencerede açılıyor. Sunucu sayfalarında başlık çubuğunun solunda "← Ana ekran" düğmesi, ayrıca Alt+←.
  - Panelin "Kapat"ı pencereyi değil sunucuyu kapatıyor, uygulama ana ekrana dönüyor.
  - Sunucu kısayolu (`baslat.vbs` → `scripts/panel-ac.mjs` → `--panel`) de aynı pencerede açıyor. Odadayken ayrı pencerede açıyor. Uygulama yoksa Edge.
  - Yalıtılmış Electron denemesiyle doğrulandı. Uygulamadan sunucu başlatma canlıda denenmedi (sunucu açıktı).
- **11470 çakışması düzeltildi:** uygulama sunucudan önce açılınca 11470'i kendi TorrServer'ıyla tutuyordu. Sunucu bunu Stremio sanıp ona düşüyor, panelde "Stremio kullanılıyor" yazıyordu. Artık uygulamanın taklidi "bırakılabilir": sunucu `POST /birak` ile portu alıyor, uygulama sunucunun motoruna geçiyor. Yalıtılmış denemede 0.3 sn.
- **Kurulumsuz eski motorla çalışıyordu:** `motor-baslat.cjs` önce `masaustu/motor`'u (paketlemede kopyalanan, gitignore'lu, 6 Ekim tarihli) okuyordu. Kurulumsuz'da bugünkü motor iyileştirmeleri yoktu, `durum()` olmadığı için açılış ekranındaki motor rozeti boş kalıyordu, `/birak` da yoktu. Artık önce `src/motor` okunuyor.
- Panelde addon satırları ve uzun torrent adları kartın dışına taşıyordu (ızgara öğesinin en küçük genişliği). Açılış ekranında bekçi satırı `hidden` iken de görünüyordu. İkisi de düzeltildi, ekran görüntüsüyle doğrulandı.
- **Otomatik kaynak bulma (Oda aç, `panel/js/new.js`):**
  - Yavaş eklentiyi beklemiyor: seçilen kalitede 4 aday gelince ölçüm başlıyor. Geç gelen eklentinin kaynakları sonraki dalgalara giriyor.
  - "Yeterince hızlı" ölçütü videoya göre: ihtiyaç (boyut / Cinemeta süresi) × 1.5, en az 4 Mbps. Süre bilinmiyorsa eskisi gibi 15 Mbps. Meta satırında `sureSn` var (`src/addons-client.js` `sureSnCoz`).
  - Dalga 6 aday (kullanıcı istedi; önce 4), en çok 25 sn: bağlanan aday 12 sn'de ölçülmüş sayılıyor, hepsi sonuçlanınca sonraki dalga. (12 sn'de kesmek, 6'sı birden açıkken geç bağlananları şans vermeden eliyordu: gerçek aramada 45 sn'de ~25 aday açıldı, biri veri verdi.) Yeni dalgada önceki dalganın en iyisi dışındakiler kapanıyor.
  - Film seçilince önceden açılan aday sayısı 6/10'dan 3/5'e indi (`src/panel-api.js`).
  - Ölçüm (tek TorrServer): tek tek açılan torrent'te film bilgisi medyan 1.6 sn. 8'i birden açılınca 10 sn, 8'in 2'si 20 sn'de gelmedi.
  - Yalıtılmış denemede (Matrix 4K, soğuk motor) ölçüm 4.3 yerine ~2.5 sn'de başladı, karar 43 yerine 39 sn'de verildi. O anki 4K adaylar zaten çok kötü bağlanıyordu (çoğu 0 kişi).
  - **İzlenebilir bulunana kadar arama** (kullanıcı istedi): 12 sınırı yok; yeten bulunana ya da adaylar bitene kadar.
    - **Boru hattı + tek başına doğrulama** (2026-10-07, `panel/js/new.js` otoDene). Araştırma: aynı torrent'ler yalnız magnet'le ve film bilgisi hazırken açıldı; ilk veri film bilgisinden bağımsız (medyan 8.4 / 8.6 sn). Belirleyen kişilere bağlanıp veri almaya başlamak, torrent'ten torrent'e 0.6-31 sn (seed sayısı tahmin etmiyor). Algoritma:
      1. 3 yuva (OTO_YUVA): aynı anda 3 aday; 30 sn'de veri vermeyen bırakılıp yerine hemen sıradaki (sabit dalga yok).
      2. İlk veri veren tek başına doğrulanıyor: ötekilerin okuması durur, bağlantıları kalır (`/api/torrent-dogrula`, dosyanın çeyreğinden 64 MB). 8 sn, ısınıyorsa 14 sn'ye kadar; 3. sn'den sonraki ortalama. Sonra ötekiler 32. MB'tan devam (`bas`).
      3. Yeten hemen seçiliyor; yetmeyenlerin en iyisi açık tutuluyor, adaylar biterse o.
      4. Hat kapasitesi (tek başına görülen en yüksek hız, localStorage `hatMbps`): taşıyamayacağı kaynaklar sona; hat 1.5 katı veremiyorsa çıta hattın %90'ı (en az 1.1 kat).
      Deneme (yalıtılmış sunucu): Silo S03E01 4K 21 sn (gerçek aramada ~2 dk), Silo S01E08 4K 17 sn, Matrix 4K 35 GB 16 sn.
    - **İnternet hızı** (elle, `data/tercih.json` `internetMbps`; oda aç sayfasında ve masaüstü açılış ekranında): videonun ihtiyacı bundan fazla olan kaynak otomatik seçimde hiç denenmiyor, listede "⚠️ ~X Mbps ister" uyarısı. Çıta da bu hıza göre. O kalitenin hepsi aşıyorsa uyarı + "1080p'ye geç". Deneme: 60 Mbps'de Matrix 4K'nın 62-73 GB'lık 5 kaynağı elendi.
    - **Yalnız tercih edilen kalite** (kullanıcı): 4K seçiliyken yalnız 4K'lar aranıyor, en iyi 4K seçiliyor. Alt kaliteye geçiş elle: 30 sn'de yeten çıkmazsa ya da adaylar biterse "1080p'ye geç" düğmesi. Hiçbiri veri vermediyse oda açılmıyor, uyarı + düğme. Odadaki otomatik geçiş de aynı kaliteden çıkmıyor.
    - Çıta ihtiyaç × 1.5; 30 sn'den sonra × 1.25, 60 sn'den sonra × 1.1. İhtiyacın altına inmiyor.
    - Yetenlerden: tercih edilen kalite > dosyada Türkçe altyazı > hız. Hiçbiri yetmezse hız/ihtiyaç oranı en iyi olan; kalitesi bilinmeyen en sonda (502 MB "?" seçilmişti).
    - Sıralama puanı: seed × grup geçmişi (0.3-3 kat) × Türkçe altyazı (1.5) × yalnız Dolby Vision (0.5). Odada bırakılan torrent'ler en sonda.
    - Canlı aday listesi (`#oto-liste`): ✓ yetiyor, ✗ bırakıldı, kalite, boyut, grup, kişi, hız / çıta.
  - **Kaynak hafızası** (`src/kaynak-hafiza.js`): yayın gruplarının iyi/kötü sayısı bütün içeriklerde. "İyi": sunucu istatistiği 8+ Mbps ya da host 2 dk takılmadan izledi (oda sayfası `kaynakIyi`; istatistik önbellekten oynarken düşük kalıyordu, Silo hiç kaydedilmemişti). Odada otomatik bırakılan ya da öneriyle değiştirilen kaynak `kaynakKotu` ile "kötü" (7 gün). `GET /api/kaynak-gruplari`.
  - **Ölçüm hatası düzeltildi:** TorrServer okuyan kalmayınca indirmeyi bırakıyor. Ölçüm 1 MB / 2 bayt okuduğu için her aday ~0 Mbps görünüyordu, seçim rastgeleydi. Artık TorrServer'da ölçümde 32 MB okunuyor (en çok 25 sn; `OLCUM_BAYT_TS`, `stremio-local.js` `okuBayt`).
  - **Tracker'sız açılma düzeltildi:** Torrentio kaynakla tracker göndermiyor. Ek liste (ngosang) alınamazsa torrent'ler 0 tracker'la açılıyordu; liste bir kez denenip bırakılıyordu. Şimdi: 1 dk arayla 5 deneme ve taklit her torrent'e `IYI_TRACKERLAR` + ek listeyi ekliyor.
  - **Dikkat:** arama çok aday denerse (Silo denemesinde 48'e kadar) evin modemine yük biniyor. Art arda denemelerden sonra tek torrent'in film bilgisi 1.6 sn'den 6 sn'ye çıktı (modem bağlantı tablosu şüphesi, kesin değil). Gerekirse aday sınırı ya da dalgalar arası bekleme eklenebilir.
- **Siteden film bilgisi:** itorrents aynı anda çok isteği kısıtlıyor (10 istekten sonra dakikalarca zaman aşımı). Artık istekler sırayla gidiyor, üst üste 2 hatada site 5 dk sorulmuyor. `http://` yönlendirmesi de izleniyor (önceden "Protocol http: not supported" veriyordu).
- **Düzeltme:** TorrServer'da ayar yazmak bütün torrent'leri kapatıyor (`SetSettings` → `dropAllTorrent`).
  - Ayar artık yalnız değiştiyse yazılıyor.
  - İzleme sırasında istenen yükleme sınırı torrent kalmayınca uygulanıyor; önceden oynatma kopuyordu.
  - TorrServer modunda "Windows onayı" uyarısı çıkmıyor.
- `npm test` 217/217 (yeni: `test/motor-yonetim.test.js`; `html-kimlik.test.js` sayfalardaki gömülü kodu derliyor). e2e 24/24 (TorrServer). Panel uçları yalıtılmış sunucuda denendi.
- Kurulum dosyaları: `D:\Botlar\Kurulumlar\BirlikteIzleMotor-Kurulum-0.7.36.exe`, `BirlikteIzleMotor-Android-0.33.0.apk`. Masaüstü 0.7.38 sunucudan otomatik güncellemeyle gidiyor.

## Bekleyen
- APK gerçek telefonda denenmedi. Telefonda sabit peer portu yok (mobil ağda UPnP işe yaramıyor).
- Kullanıcıyla Stremio kapalıyken gerçek izleme denemesi yapılmadı.
- Tarayıcı uyumluluk modu (Stremio hlsv2 dönüştürücüsü) TorrServer modunda yok.
- Arayüzde ~78 kullanıcıya görünen "Stremio" yazısı kaldı (Faz 5).
- Açılış: TorrServer medyanı 7.6 sn (önceki tur 12.9; Stremio o turda 4.1). Bunun 4–5 sn'si metadata (siteden isteme bunu kısaltıyor; gerçek kullanımda günlükteki "Torrent açılışı" ve "Film bilgisi hazır" satırlarına bak).
- Telefonun oynatıcısında (ExoPlayer) başlangıç tamponu ayarı incelenmedi.
- Windows güvenlik duvarı açık olan bilgisayarlarda TorrServer'a gelen bağlantı kuralı yok (bu bilgisayarda duvar kapalı).

## Bilinen tuzaklar
- Windows'ta Stremio `::` üzerinde dinlerken 127.0.0.1'e bağlanmak yine başarılı oluyor ve trafiği Stremio alıyor. Taklit bu yüzden `::` üzerinde dinleyip kimlik kontrolü yapıyor.
- TorrServer'ın kendi disk önbelleği yeniden açılışta kullanılmıyor; kendi blok önbelleğimiz bu yüzden var.
- Node'un `fetch`'i bu bilgisayarda Cloudflare'in IPv6 adreslerine takılıyor (IPv6 bağlantısı yok). Dış sitelere `https.get` + `family: 4` (bkz. torrent-dosyasi.js).
- `cscript baslat.vbs` sözdizimi denetimi değil, betiği çalıştırır (panel açılır).
- TorrServer zorla kapatılırsa süreç sahipsiz kalır: önce `/shutdown`.
- TorrServer'a `/settings set` göndermek açık torrent'leri kapatır. İzleme sırasında ayar yazma.
- Kurulumsuz kısayol (`masaustu` içinde electron.exe) kaynak dosyaları doğrudan çalıştırır: açılış ekranındaki hata hemen ona yansır. d72779e'de bir tırnak hatası bütün ekran kodunu durdurmuştu.
- Stremio motorunda Stremio asıl Birlikte İzle'yle ortak. Panel orada yeniden başlatma ve torrent kapatma göstermiyor.
