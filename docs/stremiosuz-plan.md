# Stremio'suz çalışma planı (motor dalı)

Bu klasör (`D:\Botlar\birlikte-izle-motor`, dal `motor`) asıl projenin
(`D:\Botlar\stremio-birlikte-izle`) kopyası. Asıl sistem olduğu gibi çalışmaya devam ediyor;
tüm Stremio'dan ayırma işi burada yapılıyor.

## Kopyanın asıldan ayrıldığı yerler

| | Asıl | Kopya |
|---|---|---|
| Portlar | 7000 / 7001 | 7300 / 7301 |
| Masaüstü uygulaması | Birlikte Izle, şema `birlikteizle://` | Birlikte Izle Motor, şema `birlikteizlemotor://`, ayrı ayar klasörü |
| Android | `xyz.birlikteizle.mobil` | `xyz.birlikteizle.mobil.motor` (yan yana kurulabilir) |
| Veri | `data/` | kendi `data/`'sı (ayarlar kopyalandı, `kesif.json` yeni: uygulamalar karışmıyor) |

Faz 1 bitene kadar kopya da bilgisayardaki **aynı Stremio'yu** kullanıyor. Asıl sunucunun
torrent'lerine dokunmasın diye kopyada `PAYLASILAN_STREMIO` koruması var (server.js).

## Stremio bugün ne iş görüyor

Stremio'nun yayın sunucusu (127.0.0.1:11470) = enginefs + **torrent-stream** + ffmpeg
(kurulu `server.js` içinde doğrulandı). Bizim kullandığımız parçaları:

1. Torrent indirme ve video dosyasını aralıklı (Range) sunma: `/<hash>/<sıra>`
2. İstatistik: `/<hash>/stats.json`, `/stats.json` (peer, hız, ilerleme)
3. Torrent kapatma/açma: `/<hash>/remove`, `/<hash>/create` (ek tracker'lar)
4. Ayarlar: `/settings` (bağlantı sınırı vb., "Stremio açık mı" denetimi)
5. Uyumlu mod: `/hlsv2/...` (ffmpeg ile HLS'e çevirme; tarayıcıdaki misafirler ve
   telefonda çözülemeyen ses, örn. DTS)
6. Altyazı eşleme: `/opensubHash`

Stremio'dan bağımsız olanlar (değişmeyecek): eklentiler (Torrentio vb. düz HTTP, sunucu zaten
kendisi çağırıyor), Cinemeta arama, altyazı eklentileri, odalar, senkron, canlı yayın.

Stremio yüzünden yazdığımız geçici çözümler (motor gelince kalkacak): `stremio-parca.js`,
`stremio-vekil.cjs`, `ParcaliKaynak.kt` (ucu açık aralık birikmesi), `stremio-restart.js` ve
`takilma.js` (Stremio'nun takılıp yeniden başlatılması), `yukleme-siniri.js` (Windows QoS ile
yükleme sınırı), `torrent-hiz.stremioAyarla`, "Stremio açık değil" uyarıları, "Stremio'ya
bağlan" ve "Stremio'yu yeniden başlat" düğmeleri.

## Temel karar: Stremio ile aynı dili konuşan kendi motorumuz

Sunucunun içinde **torrent-stream** ile çalışan bir motor; Stremio'nun kullandığımız HTTP
uçlarının aynısını kendi portunda (127.0.0.1:11471) sunuyor. Böylece relay, kaynak denetimi,
temizlik ve istatistik kodu yalnızca adres değişerek çalışıyor; büyük yeniden yazım yok.

Neden torrent-stream: Stremio'nun kendi motoru da bu, yani hız aynı sınıfta. Saf JavaScript,
masaüstü uygulamasına tek dosya olarak paketlenebiliyor (uygulamanın `node_modules`'u yok,
güncelleme dosya dosya iniyor). webtorrent'in uTP/WebRTC desteği yerel (native) modül
istiyor, paketlemesi zor.

## Fazlar

Her faz tek başına çalışır halde bitiyor. Stremio, son faza kadar seçilebilir yedek olarak
duruyor (Ayarlar: Motor = Dahili / Stremio).

### Faz 0: Ölçümü tamamla (kısa, Sonnet yeter)
- `deneme/motor/olc.mjs`: webtorrent okuma takılması (`deselect`) düzeltilecek.
- Sen izlemiyorken 3 torrent x 2 tur: Stremio ve torrent-stream yan yana (açılış, hız, sarma,
  peer, RAM/CPU).
- Karar ölçütü: torrent-stream, Stremio'dan belirgin kötü değilse devam. Kötüyse webtorrent ya
  da libtorrent tabanlı bir yardımcı program (TorrServer) yeniden değerlendirilecek.

**Faz 0 sonucu (2026-10-06):** ölçüm kodu `deneme/motor/olc2.mjs`. Torrent'ler önbelleksiz ve
yeni seçildi; 9 torrent kullanıldı, motorların DHT'si ölçüm öncesinde ısındı, hat yaklaşık 50 Mbps.

| Motor | Başarılı | Açılış | İzleme | Sarma (%35 / %80) |
|---|---|---|---|---|
| Stremio | 6/9 | 7.6 sn | 38.1 Mbps | 3 / 2.2 sn |
| TorrServer | 7/9 | 11 sn | 32 Mbps | 2.5 / 2 sn |
| libtorrent (basit akış katmanı) | 9/9 | 13.2 sn | 15.1 Mbps | 9.4 / 5.5 sn |
| webtorrent | 9/9 | 14.4 sn | 19.6 Mbps | 4.5 / 5.3 sn |
| rqbit | 5/9 | 8.9 sn | 22.4 Mbps | 3.3 / 4.7 sn |
| torrent-stream | 6/9 | 13.8 sn | 8.4 Mbps | 13 / 11.6 sn |

Tabloda açılış, izleme ve sarma için medyan değerler var.

Sonuçlardan çıkanlar:
- **torrent-stream elendi.** Stremio'nun çekirdeği olmasına rağmen tek başına en kötü sonucu verdi;
  Stremio'nun iyi sonucu çekirdekten değil, onun üstüne kurduğu ayarlardan geliyor. Yukarıdaki
  "torrent-stream" kararı geçersiz.
- **Stremio'da uTP kapalı** (`utp: !1`). UPnP'yi yalnız DLNA için kullanıyor, port açmıyor.
- **libtorrent hiçbir torrent'te takılmadı.** Yavaş kısımları (sarma, izleme), deneme için
  yazılan basit akış katmanından (`lt_sunucu.py`) kaynaklanıyor.
- **Aday:** libtorrent ve üstüne kendi akış katmanımız. Telefonda da aynı çekirdek
  (libtorrent4j) kullanılabilir.
- **Yedek:** TorrServer (hazır, Windows ve Android ikilisi var, ancak 64 MB).

Karar için akış katmanı düzeltilip Stremio ve TorrServer'la yeniden ölçülecek.

**İkinci tur (2026-10-06, 9 yeni torrent):** libtorrent katmanı düzeltildi (parça durumu
alarmlardan takip, sınırlı acil pencere, tüm tracker'lara aynı anda istek).

| Motor | Başarılı | Açılış | İzleme | Sarma (%35 / %80) | Peer |
|---|---|---|---|---|---|
| Stremio | 7/9 | 4.1 sn | 37.5 Mbps | 2 / 1.9 sn | 13 |
| TorrServer | 7/9 | 12.9 sn | 27.9 Mbps | 2.8 / 2.1 sn | 20 |
| libtorrent | 8/9 | 13.4 sn | 14.8 Mbps | 12.1 / 11.5 sn | 24.5 |

İki turun toplamı (18 torrent):
- Açılan torrent: Stremio 13, TorrServer 14, libtorrent 17.
- libtorrent en çok peer'e bağlanıyor ve en çok torrent'i açıyor.
- Ama tek parçayı almakta yavaş: sarma 12 sn, Stremio'da 2 sn. Hızlı bir katmanla düzelmedi.
  Akış için ayarlanması ayrı bir araştırma işi, sonucu belirsiz.

Hızda Stremio hâlâ önde. Stremio'suz en yakın seçenek TorrServer.

Ölçüm kodunda dikkat edilecek bir nokta var. TorrServer bir torrent'te 7.8 sn'de hata verdi.
Muhtemel sebep dosya sırası uyuşmazlığı: TorrServer dolgu (pad) dosyalarını listelemiyor
olabilir. Bu doğruysa TorrServer'ın sonucu bir torrent kadar haksız yere düşük çıktı.

### Faz 1: Host sunucusunda dahili motor (Opus)
- `src/motor/`: torrent açma/kapama, istenen dosyayı seçme, okunan yerin parçalarını öne alma,
  bağlantı sınırı (80), yükleme hız sınırı (kendi içinde; QoS'a gerek kalmıyor).
- Disk önbelleği: `data/onbellek`, boyut sınırı (varsayılan 20 GB, Ayarlar'dan), en eski
  kullanılan siliniyor.
- HTTP uçları 127.0.0.1:11471: `/<hash>/<sıra>` (Range, HEAD), `stats.json`'lar,
  `remove`, `create`, `settings`, `opensubHash` (OpenSubtitles hash'i kendimiz hesaplıyoruz).
- `STREMIO_BASE` yerine `MOTOR_BASE`; panelde motor seçimi.
- Testler: internetsiz uçtan uca deneme. `test.mp4`'ten torrent oluşturulup testin içinde
  yerelde paylaşılıyor, oda bu torrent'le açılıp oynatılıyor.
- Sonuç: host bilgisayarında Stremio kapalıyken oda açılıyor, host ve relay'li misafirler
  izleyebiliyor.

### Faz 2: Masaüstü uygulaması (Opus)
- Aynı motor esbuild ile tek dosya (`electron/motor.cjs`), güncelleme listesine ekleniyor.
- Uygulama, aynı bilgisayardaki sunucunun motoru açıksa onu kullanıyor (host'ta çift indirme
  olmasın), yoksa kendi motorunu başlatıyor.
- `stremio-vekil.cjs` ve Stremio'ya özel istekler kalkıyor; mpv doğrudan motordan okuyor.
- "Birlikte Izle Motor" kurulumu üretiliyor.

### Faz 3: Android (Opus, en riskli faz)
- Telefonda Stremio yerine **libtorrent4j** (libtorrent'in Java bağlaması, LibreTorrent de
  bunu kullanıyor) ve 127.0.0.1:11471'de aynı uçları sunan küçük bir HTTP sunucusu.
- Oynatılan yerin parçaları süre sınırıyla öne alınıyor (`set_piece_deadline`).
- `ParcaliKaynak.kt` ve "Stremio'ya bağlan" akışı kalkıyor.
- APK yaklaşık 8 MB büyüyor (yalnız arm64).
- Telefonda motor açılamazsa relay (host üzerinden izleme) yedek olarak duruyor.

### Faz 4: Uyumlu mod / ses dönüştürme (Opus)
- ffmpeg ilk gerektiğinde indirilip `data/araclar` altına kuruluyor (yaklaşık 90 MB, kurulum
  paketini şişirmesin).
- HLS üretimi: görüntü mümkünse kopyalanıyor, yalnız gereken (çoğunlukla ses: DTS, TrueHD)
  AAC'ye çevriliyor.
- Kullananlar: tarayıcıdaki misafirler ve DTS sesli dosyada telefon. mpv'li masaüstü
  uygulamasının buna ihtiyacı yok.

### Faz 5: Temizlik (Sonnet)
- Yukarıdaki Stremio geçici çözümleri, uyarıları ve düğmeleri siliniyor.
- Stremio eklentisi (`addon.js`) isteğe bağlı kalıyor: Stremio'da gezinip "Birlikte İzle" ile
  oda açmak isteyen için zararsız.

### Faz 6: Asıla geçiş
- Kopya bir süre gerçek kullanımda denendikten sonra iki yol var:
  - `motor` dalı asıl projeye birleştirilir;
  - ya da kopya asılın yerine geçer.
- Portlar, uygulama adları ve paket kimliği geri alınıyor.

## Riskler

- **torrent-stream eski bir kütüphane:** son sürümü yıllar önce çıktı. Stremio hâlâ kullandığı
  için sağlamlığı kanıtlanmış; bulduğumuz hatalar kendi kodumuzda düzeltilecek.
- **uTP desteği yok:** NAT arkasındaki bazı peer'lere ulaşılamıyor. Stremio'da da aynı sınır
  var, bugünkünden kötü değil.
- **Telefonda pil ve depolama:** önbelleğe sınır konacak; uygulama kapanınca torrent'ler
  kapanacak.
- **Ses dönüştürme:** ffmpeg olmadan (Faz 4'ten önce) DTS sesli dosyalar telefonda sessiz
  açılabilir. O zamana kadar bu durumda Stremio yedeği kullanılacak.
