# Masaüstü ve telefon istemcisi — plan

2026-09-26. Karar verildi, uygulanmadı.

## Neden

Tarayıcı, odadaki dosyaların çoğunu doğrudan açamıyor: HEVC, Dolby Vision, AC3/DTS ses, çoklu ses
parçası. Bu yüzden "Uyumlu mod" (Stremio'nun hlsv2 dönüştürücüsü) devreye giriyor ve şu bedelleri
getiriyor: host'un CPU'su dönüştürme yapıyor, trafik relay'den geçiyor, HDR görüntü SDR'ye
çevrildiği için karanlık/soluk çıkıyor, 4K'da kare kaybı oluyor, ses dili seçilemiyor.

Kök sebep: sayfa, videoyu tarayıcının `<video>` etiketiyle oynatmak zorunda ve Stremio'nun yerel
sunucusu (127.0.0.1:11470) sayfaya CORS izni vermiyor. Yerel bir uygulama bu iki kısıta da takılmaz.
Stremio'nun kendisi de zaten `libmpv-2.dll` ile bunu yapıyor (kurulu: `%LOCALAPPDATA%\Programs\Stremio`).

## Ortak temel

Sunucu ve oda mantığı değişmiyor. İstemciler mevcut protokolü konuşuyor:

- **Gönderilen olaylar:** `join`, `control`, `status`, `chat`, `setOwnStream`, `setHostStream`,
  `settings`, `skipWaiting`, `kick`, `requestRelay`.
- **Dinlenen olaylar:** `playback`, `users`, `chat`, `hostStream`, `content`, `subtitles`,
  `hostSubtitle`, `waiting`, `torrentStats`, `settings`, `hostChanged`, `relayRevoked`, `kicked`,
  `replaced`, `roomClosed`.
- **Aynen kullanılacak saf modüller** (ikisi de DOM'a dokunmuyor, sunucu da kullanıyor):
  - `public/js/shared/sync-core.js` — senkron matematiği (`expectedPosition`, `driftAction`,
    `estimateClockOffset`). Android'e ~30 satır Kotlin çevirisi.
  - `public/js/shared/stream-url.js` — torrent URL'i ve tracker parametreleri.

Masaüstü istemci repo içinde `masaustu/` klasöründe durur; paylaşılan modülleri göreli `import` ile
alır, böylece tek sürüm kalır.

## A) Masaüstü istemci (Windows)

Karar: **Electron + gömülü mpv**, **host ve misafirler için**.

Video kaynağı sırası:
1. Kendi Stremio'su açıksa `127.0.0.1:11470/<infoHash>/<fileIdx>` — doğrudan, relay yok, host'a yük yok.
2. Değilse host'un relay'i (`/relay/<oda>/<anahtar>/<infoHash>/<fileIdx>`) — ham dosya. mpv her şeyi
   kendi çözdüğü için **Uyumlu mod yine gerekmiyor**: host sadece upload verir, CPU'su dönüştürmez.

Kazanç: gerçek HDR10/Dolby Vision, tüm ses parçaları, gömülü altyazılar, donanım çözme, 4K'da kare
kaybı yok. Kendi Stremio'su olan misafir relay'den tamamen çıkar.

| Faz | İş | Model |
|---|---|---|
| 0 | ✅ **Bitti** (2026-09-26). Prototip: `masaustu/` — odaya bağlanır, mpv'yi başlatır, senkron tutar. | Opus |
| 1 | 🔶 **Çekirdek çalışıyor** (2026-09-26). Electron kabuk: mevcut web arayüzü, `<video>` yerine gömülü mpv | Opus |
| 2 | Kurulum paketi, ayarlar, mpv'yi bulma/indirme | Sonnet |

### Faz 0 kapsamı (önce bu)

`masaustu/prototip.js`, komut satırından: `node prototip.js <oda-linki> <isim>`.

- `socket.io-client` ile odaya katılır (`join`), `hostStream` olayından oynatılacak kaynağı alır.
- mpv'yi `--input-ipc-server=\\.\pipe\birlikte-izle` ile başlatır, JSON IPC üzerinden konuşur.
- `playback` olayı gelince `sync-core` ile hedef konumu hesaplar; sapmaya göre mpv'nin `speed`
  değerini ayarlar ya da `seek` yapar.
- mpv'den `time-pos`/`pause` okuyup `status` gönderir (host'un izleyici listesi doğru kalsın).
- Host ise mpv'deki duraklat/sar hareketini `control` olarak odaya yollar.

Bu fazın tek amacı şu soruyu kesin cevaplamak: **senkron, native oynatıcıda tarayıcıdaki kadar
sıkı tutuyor mu?** Tutmazsa Electron'a hiç girilmez.

Doğrulanacak riskler: Windows'ta mpv IPC (adlandırılmış boru) Node'dan çalışıyor mu; `speed` ile
sapma düzeltmesi mpv'de pürüzsüz mü; mpv'nin başlangıç gecikmesi senkronu bozuyor mu.

**Başarı ölçütü** (iki prototip örneğini aynı bilgisayarda yan yana çalıştırarak ölçülür):
sabit oynatmada sapma < 0.3 sn; host sardıktan sonra 3 sn içinde toparlama; 10 dakikalık izlemede
kendiliğinden birikmiş sapma yok.

### Faz 0 sonucu (2026-09-26): senkron tutuyor

Ölçüm düzeni: gerçek oda mantığını çalıştıran yalıtılmış bir deneme sunucusu (:7100) + sahte bir
http stream (ffmpeg ile üretilmiş 120 sn'lik klip). Torrent, addon ve kullanıcının canlı sunucusu
işin içine girmedi.

| Ölçüt | Hedef | Ölçülen |
|---|---|---|
| Sabit oynatmada sapma | < 0.3 sn | **0.02-0.03 sn** |
| İki izleyici arasındaki fark | — | **~0.01 sn** |
| Sarma sonrası toparlanma | < 3 sn | **< 1 sn** |
| Saat farkı tahmini | — | 0-1 ms |

Ayrıca doğrulandı: oynarken katılan geç izleyici doğru konuma atlıyor; duraklatma tam isabetli
(sapma 0); istemcinin `status` bildirimi sunucuya ulaşıyor (yani **bekleme mekanizması çalışıyor**,
oda native istemciyi de doğru bekliyor); mpv IPC üzerinden sarma, hız ayarı ve duraklatma sorunsuz.

Bulunan ve düzeltilen hata: `property-change` dinleyicisi `observe_property` çağrılarından sonra
bağlanınca mpv'nin gönderdiği **ilk değerler kaçıyordu**; bu yüzden istemci "duraklatılmış"
varsayımında takılıp sonsuz "oynat" komutu gönderiyor, sapmayı hiç hesaplamıyordu. İlk iki
istemcide gizlenmişti (onlarda oda duraklalı başladığı için `pause` gerçekten değişiyordu); yalnız
oynayan bir odaya geç katılanda ortaya çıktı.

Henüz denenmedi: gerçek torrent kaynağı, HDR/DV görüntü, çoklu ses parçası, ortak altyazı,
host kilidi, 10 dakikalık uzun izleme.

## Gözden kaçmaması gerekenler

Aşağıdakiler yalnızca istemcinin kendi görüntüsünü değil, **odadaki diğer kişileri** de etkiliyor.
Faz 1'den önce çözülmeli, Faz 0'da en azından bilinçli olarak dışarıda bırakılmalı.

1. **Bekleme (waiting) katılımı.** Biri takılınca oda herkesi duraklatıyor (`waiting` olayı,
   `waitMode` ayarı). İstemci `status` ile "takılıyorum/hazırım" bildirmezse, oda bu kişiyi hiç
   beklemez ya da tersine sonsuza kadar bekler. Yani `status` isteğe bağlı değil, zorunlu.
2. **Host kilidi.** `settings.locked` açıkken oynatmayı sadece host kontrol eder. İstemci bunu
   uygulamazsa, misafirin mpv'de bastığı duraklat/sar sessizce kendi görüntüsünü kaydırır ve
   senkron bozulur. Kilitliyken mpv'deki kullanıcı hareketi geri alınmalı.
3. **Ortak altyazı.** Oda tek bir altyazıyı paylaşıyor (`hostSubtitle`: `subId` + `offset`).
   İstemci bunu sunucudan çekip mpv'ye `sub-add` ile yüklemeli, gecikmeyi `sub-delay` ile
   uygulamalı. Yapılmazsa web'e göre gerileme olur.
4. **İçerik değişimi.** Host başka bir filme geçince (`content` olayı) mpv yeniden yüklenmeli.
5. **mpv.exe ayrı bir şey.** Stremio `libmpv-2.dll` getiriyor, bu Node'dan kolay sürülmüyor.
   Bize bağımsız `mpv.exe` (~40 MB) lazım: uygulamayla paketlenir ya da ilk açılışta indirilir.
6. **Misafirin Stremio'sunda torrent birikmesi.** İstemci doğrudan kendi Stremio'sunda torrent
   açıyor. Sunucudaki temizlik (`stopOtherDownloads`) yalnızca host'un Stremio'suna bakıyor;
   misafirin makinesinde açılan torrent'leri kimse kapatmıyor. İstemci çıkarken/kaynak
   değiştirirken kendi torrent'lerini `/<infoHash>/remove` ile kapatmalı.
7. **İnmemiş yere sarma.** Torrent'in inmemiş bir yerine sarınca mpv uzun süre donabilir. Tarayıcı
   tarafında 60 sn'lik zaman aşımı var; istemcide de benzer bir sınır ve kullanıcıya bilgi gerekir,
   yoksa oda bu kişiyi beklerken herkes takılır.

### Faz 1 gömme riski: çözüldü (2026-09-26)

`masaustu/electron/gomme-kaniti.cjs` ile doğrulandı. mpv, Electron penceresinin video alanına
gömülüyor; kenar çubuğu ve kontroller normal web arayüzü olarak yanında duruyor. Pencere taşınıp
yeniden boyutlandırıldığında hizalama korunuyor. Yedek plana (ayrı pencere) gerek kalmadı.

Çalışan düzen:
1. Ana pencere web arayüzünü çizer; video alanı boş bir `<div>`.
2. Oluşturucu, `ResizeObserver` ile o div'in ölçüsünü ana sürece bildirir.
3. Ana süreç, çerçevesiz bir **alt pencereyi** o ölçüye hizalar ve HWND'sini mpv'ye `--wid` ile verir.
4. Ana pencerenin `resize`/`move` olaylarında yeniden ölçüm istenir.

Üç tuzak (hepsi bu kanıt sırasında ısırdı):
- **Alt pencere saydam olmalı** (`transparent: true`, `backgroundColor: '#00000000'`). Aksi halde
  Chromium o pencereyi boyar ve mpv'nin üstünü kapatır: görüntü **tamamen siyah** gelir. Gömmenin
  çalışmadığı sanılabilir, oysa yalnızca üstü örtülmüştür.
- **Ana süreç CommonJS olmalı.** Electron 33'te ESM ana süreç `electron` modülünü çözerken patlıyor.
  ESM modüllerimiz (`mpv.js`, `karar.js`) ana süreçten dinamik `import()` ile alınmalı.
- **Electron sürümü Node 20 ile uyumlu olmalı.** Electron 44'ün kurulum betiği Node ≥ 22.12 istiyor
  (`require(esm)`), Node 20.12'de kurulum yarıda kalıyor. Electron 33 sorunsuz.

Koordinatlar: `getContentBounds()` ve `setBounds()` aynı (mantıksal) uzayda çalıştığı için ölçek
çarpanıyla uğraşmaya gerek yok. Win32'den okunan fiziksel pencere konumu bunlarla eşleşmez -
doğrulama için ekran görüntüsü alırken bu karıştırılmamalı.

### Faz 1 çekirdeği çalışıyor (2026-09-26)

Dosyalar: `masaustu/electron/` — `ana.cjs` (ana süreç), `onyukleme-kabuk.cjs` (önyükleme),
`video-koprusu.cjs` (video köprüsü), `masaustu.css` (düzen farkları), `baslangic.html`.

**Mimari kararı: oda sayfası aynen kullanılıyor.** Sohbet, izleyiciler, kalite listesi, altyazı
sekmesi, senkron, soket - hepsi mevcut web kodu. Yalnızca sayfadaki `<video>` öğesinin özellikleri
ve yöntemleri mpv'ye yönlendiriliyor (`video-koprusu.cjs`): `currentTime`, `duration`, `paused`,
`readyState`, `seeking`, `playbackRate`, `videoWidth/Height`, `buffered`, `volume`, `muted`, `src`,
`play()`, `pause()` ve `loadedmetadata`/`canplay`/`play`/`pause`/`seeked`/`timeupdate` olayları.
Sayfa normal bir oynatıcıyla konuştuğunu sanıyor; arayüzü yeniden yazmaya gerek kalmadı.

Doğrulandı (yalıtılmış deneme odasında, ekran görüntüsüyle): oda arayüzü masaüstü penceresinde
çalışıyor, görüntüyü mpv çiziyor, süre/konum/seek çubuğu mpv'den besleniyor, kontroller ve sohbet
çalışıyor.

Üç tuzak daha (hepsi bu aşamada ısırdı):
- **`sandbox: false` şart.** Kum havuzunda önyükleme betiği yerel dosyaları `require` edemiyor;
  köprü sessizce kurulmuyor ve sayfa tarayıcı oynatıcısını kullanmaya devam ediyor. Hata görünmez
  olduğu için teşhisi zor - bu yüzden `onyukleme-kabuk.cjs` içinde try/catch + `console.error` var.
- **`contextIsolation: false` şart.** Yalıtılmış bağlamda `defineProperty` sayfanın gördüğü nesneyi
  değiştirmiyor (ayrı JS dünyaları).
- **Stil gömülerek eklenmeli.** http sayfasından `file://` stil yüklemesi engelleniyor; sessizce
  başarısız olup düzeni bozuyor.

Ayrıca: sayfa, mpv hazır olmadan `video.src` verebiliyor (odaya girer girmez). Bu adres saklanıp
mpv açılınca yükleniyor, yoksa görüntü siyah kalıyor.

**Altyazı mpv'ye bağlandı (2026-09-26).**

Sayfa altyazıyı kendi HTML katmanında çiziyordu; mpv yerel (native) bir pencerede çizdiği için
ne o katman ne de `<track>` ipuçları görüntünün üstüne gelebiliyor. Çözüm: altyazıyı mpv çiziyor.

Akış: `subs.js` → `window.masaustuAltyazi.uygula(url, offset)` → köprü metni `fetch` ile okur
(adres `blob:` ya da göreli olabilir, mpv ikisini de açamaz) → ana süreç geçici `.vtt` yazar →
`sub-add … select`. Stil de aynı yoldan gider: yazı %100 = mpv'nin 55'i, konum yüzdesi `sub-pos`,
gecikme `sub-delay`.

Üç ayrıntı:
- Her seçimde bir önceki dış altyazı `sub-remove` ile atılmazsa mpv'de parça birikiyor; geçici
  dosya da ancak parça çıkarıldıktan sonra silinebiliyor (mpv dosyayı açık tutuyor).
- `loadfile` altyazıyı düşürüyor, bu yüzden `file-loaded` olayında yeniden ekleniyor.
- Arka plan kutusunu mpv yalnızca `sub-border-style=background-box` ile çiziyor; `sub-back-color`
  tek başına hiçbir şey yapmıyor. Kutu açıkken kenarlık seçimi devre dışı kalıyor.

Sayfa tarafındaki ekleme iki satır: `apply()` ve `applyStyle()` içinde `window.masaustuAltyazi?.`
çağrısı. Tarayıcıda bu nesne olmadığı için hiçbir şey değişmiyor.

Doğrulandı: seçim, kapatma, tekrar seçme, gecikme düğmeleri, yazı boyutu, arka plan; parça
birikmiyor, kapanışta geçici dosya kalmıyor.

**Ses parçası seçimi bağlandı (2026-09-26).** mpv'nin `track-list`'indeki ses parçaları sayfaya
`masaustu-sesler` olayıyla bildiriliyor; seçim `aid`'i değiştiriyor. Etiketi sayfa üretiyor.
Önyükleme betiği sayfa betiklerinden sonra çalıştığı için haber verme olayla yapılıyor - sayfanın
kurduğu geri çağırmaya güvenilemiyor. İki ses parçalı dosyayla doğrulandı (Türkçe/İngilizce).

**Tam ekran**: sayfa tam ekrana geçince pencere de tam ekran oluyor ve hizalama düzeliyor.
Bilinen sorun: Windows görev çubuğu videonun alt şeridinin üstünde kalıyor (mpv doğal pencere).

**Oda linkiyle giriş** (`baslangic.html`) denendi, çalışıyor.

**Kalan işler:**
- Görüntü oranı düğmeleri (şimdilik gizli; mpv kendi sığdırmasını yapıyor), izleyici katmanı
  (mpv doğal pencere olduğu için üstüne çizilemiyor).
- Tam ekranda görev çubuğu sorunu.

## B) Android uygulaması

- Kotlin + Media3/ExoPlayer. Araçlar kurulu (Gradle 8.0, AGP 8.0.2, Kotlin 1.8.22, SDK 34).
- Senkron: Socket.IO Java istemcisi + `sync-core`'un Kotlin çevirisi.
- **Video yine host'un relay'inden akar** — telefonda torrent motoru yok, bu değişmiyor. Kazanç,
  ExoPlayer'ın HEVC/AC3'ü telefonun donanımıyla açması: host artık telefon için CPU'da dönüştürme
  yapmıyor.
- Resim-içinde-resim, arka planda ses, düzgün tam ekran.
- **iOS kapsam dışı**: Mac ve yıllık 99$ geliştirici hesabı gerekiyor. iPhone için mevcut web sayfası
  yedek olarak kalır.

## Sıra

Önce masaüstü Faz 0. Sonuca göre Faz 1, ardından Android.
