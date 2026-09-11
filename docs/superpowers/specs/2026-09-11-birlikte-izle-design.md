# Birlikte İzle — Tasarım

Tarih: 2026-09-11
Durum: Uygulandı (tüm aşamalar). Uygulamada verilen kararlar §24'te.

## 1. Amaç

Peario benzeri bir Stremio "birlikte izleme" eklentisi. Stremio'da bir film veya bölüm açıldığında stream listesine "Birlikte İzle" seçeneği eklenir. Seçilince tarayıcıda bir oda açılır, oda linki arkadaşlarla paylaşılır. Oynatma (oynat/duraklat/sar) herkeste senkron ilerler. Odada sohbet, izleyici listesi ve altyazı vardır.

Sunucu, kullanıcının kendi Windows PC'sinde çalışır ve Cloudflare hızlı tüneli (quick tunnel) ile internete açılır. PC'deki işler bir kontrol paneli (GUI) üzerinden yönetilir.

## 2. Temel kararlar

| Konu | Karar |
|---|---|
| Video kaynağı | Her izleyici torrent'i kendi Stremio streaming server'ından (`127.0.0.1:11470`) oynatır. Sunucu video taşımaz. İstisna: "host üzerinden izle" (relay) modu. |
| Stream listesi kaynağı | Panelde ayarlanan addon manifest URL'leri (Torrentio vb.). Stremio hesabıyla giriş yok. |
| Barındırma | Kullanıcının PC'si + Cloudflare quick tunnel (hesap gerekmez, URL her açılışta değişir). |
| Oda açma | Sadece sunucunun çalıştığı PC'den. Misafirler sadece katılır. |
| Teknoloji | Node.js 20 (ESM), Express 4, Socket.IO 4, arayüz için sade HTML/CSS/JS (build adımı yok), `hls.js`. |
| GUI | Node sunucusunun sunduğu web panel, Edge `--app` penceresinde açılır. |
| Arayüz dili | Türkçe. |
| Kalıcılık | Odalar RAM'de tutulur. Ayarlar `data/config.json` dosyasında. |

## 3. Mimari

```
Stremio (host PC)
  film aç → GET http://127.0.0.1:7000/stream/movie/tt123.json
         ← { streams: [{ name: "👥 Birlikte İzle", externalUrl: "http://127.0.0.1:7001/new?type=movie&id=tt123" }] }
  tıkla → tarayıcıda /new açılır (panel portu)

Node sunucusu (host PC)
  :7000  public   → eklenti, oda sayfası, Socket.IO, altyazı dosyaları, relay     ← cloudflared tüneli buraya
  :7001  panel    → GUI paneli, /new sayfası, oda oluşturma, ayarlar             ← sadece 127.0.0.1, tünel yok
  cloudflared alt süreci → https://<rastgele>.trycloudflare.com → :7000

İzleyici tarayıcısı
  oda sayfası (https://<tünel>/room/AB12CD veya host için http://127.0.0.1:7000/room/AB12CD)
  ├─ Socket.IO ↔ sunucu: senkron, sohbet, durum
  └─ <video> kaynağı: kendi 127.0.0.1:11470'i | relay (tünel üzerinden host PC) | doğrudan HTTP
```

İki portlu yapı güvenlik için zorunludur. cloudflared trafiği localhost'tan getirdiği için tek portta "sadece yerel istek" kontrolü güvenilir değildir. Her iki sunucu da yalnızca `127.0.0.1` adresine bağlanır. İnternetten tek giriş yolu tünel, tünel de sadece :7000'e gider.

## 4. Stremio eklentisi (`src/addon.js`, :7000)

Manifest (`/manifest.json`):

```json
{
  "id": "community.birlikteizle",
  "version": "0.1.0",
  "name": "Birlikte İzle",
  "description": "Arkadaşlarınla senkron izleme odası aç",
  "resources": ["stream"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "catalogs": [],
  "behaviorHints": { "configurable": true }
}
```

- Eklenti Stremio'ya `http://127.0.0.1:7000/manifest.json` adresinden kurulur. Bu adres hiç değişmez.
- `/stream/:type/:id.json` her zaman tek bir stream döndürür: `externalUrl: http://127.0.0.1:7001/new?type=<type>&id=<id>`. Dizi id'si `tt123:1:2` biçimindedir.
- `/configure` adresi `http://127.0.0.1:7001/` (panel) adresine yönlendirir.
- CORS: eklenti uçları `Access-Control-Allow-Origin: *` döner (Stremio web istemcisi için gerekli).

## 5. Oda oluşturma akışı (:7001)

1. `/new?type&id` sayfası açılır. İçeriğin adı ve posteri Cinemeta'dan alınır (`https://v3-cinemeta.strem.io/meta/<type>/<imdbId>.json`, dizide bölüm adı `videos` listesinden). 5 sn zaman aşımı vardır, hata olursa id gösterilir.
2. Sayfa `GET /api/streams?type&id` çağırır. Sunucu, ayarlı ve açık her addon'un `/stream/<type>/<id>.json` ucunu paralel çağırır. Her addon için 10 sn zaman aşımı vardır. Sonuç addon'a göre gruplanır, hata veren addon'lar ayrıca listelenir.
3. Stream normalizasyonu (`src/streams.js`):
   - Tür: `torrent` (infoHash + isteğe bağlı fileIdx + sources) veya `http` (url). `ytId` ya da sadece `externalUrl` içeren stream'ler atılır.
   - Kalite etiketi: ad/başlık içinden `2160p|4k|1080p|720p|480p` aranır.
   - Boyut: `behaviorHints.videoSize` alanından, yoksa başlıktaki `💾 x GB` ifadesinden okunur.
   - `behaviorHints.notWebReady` olan stream'ler "uyumlu mod gerekli" olarak işaretlenir.
   - Her stream'e oda içinde kullanılacak kısa bir `streamId` verilir.
4. Host bir stream seçer. `http` türünde bir stream seçilirse Real-Debrid uyarısı gösterilir ve onay istenir (bkz. §13).
5. `POST /api/rooms {type, id, streamId}` çağrısı yapılır. Sunucu odayı oluşturur, altyazı listesini çeker (§10) ve `{roomId, creatorToken}` döndürür.
6. Tarayıcı `http://127.0.0.1:7000/room/<roomId>#host=<creatorToken>` adresine yönlenir. Oda sayfası bu değeri kendi `userToken`'ı olarak `localStorage`'a yazar ve adresteki `#` kısmını temizler. Böylece oda sahibi, token'ı `creatorToken` ile aynı olan sıradan bir kullanıcı olarak katılır. Ayrı bir host anahtarı yoktur.

## 6. Oda sayfası (:7000, `/room/:roomId`)

- **Katılım:** "Kullanıcı adı + Katıl" ekranı gösterilir. Ad `localStorage`'da hatırlanır ama Katıl'a basmak her seferinde gerekir. Bu tıklama, tarayıcıların ses açık otomatik oynatma kuralı için de gerekli olan kullanıcı etkileşimini sağlar. iOS dahil.
- **Kimlik:** her tarayıcı rastgele bir `userToken` üretir ve `localStorage`'da saklar. Yeniden bağlanıldığında aynı token ile aynı kullanıcı sayılır.
- **Link kopyala:** tünelin güncel public URL'si ile `https://<tünel>/room/<roomId>` kopyalanır. Tünel kapalıysa uyarı gösterilir.
- **Düzen:** masaüstünde video solda, sağda sekmeli panel (Sohbet / İzleyiciler / Altyazı / Kalite) bulunur. Mobil dikey ekranda video üstte, sekmeli panel altta durur. Yatayda tam ekran. Dokunmatik kontroller büyüktür.

## 7. Oynatma (`public/js/player.js`)

### 7.1 Kaynak seçimi

**CORS kısıtı (spike ile doğrulandı):** Stremio streaming server CORS başlığını sadece kendi alan adlarına ve `peario.xyz`'ye veriyor. Bu yüzden sayfamız 11470'ten `fetch` ile veri **okuyamaz**. `<video src>` CORS gerektirmediği için oynatma çalışır. Tasarımın bu bölümü buna göre kurulmuştur: sayfa 11470'e sadece `no-cors` yoklama ve `<video src>` ile erişir. Yanıtı okunması gereken her çağrı (altyazı hash'i, relay) host PC'deki bizim sunucumuzdan yapılır.

Torrent stream için sırasıyla denenir:

1. **Yerel Stremio:** `fetch('http://127.0.0.1:11470/settings', {mode: 'no-cors'})` 2 sn zaman aşımıyla yoklanır. İstek hatasız dönerse (opak yanıt) Stremio açık kabul edilir. Video adresi `http://127.0.0.1:11470/<infoHash>/<fileIdx>?tr=<source>&tr=<source>...` olur. Stremio bu istekte torrent'i kendisi başlatır, ayrı kayıt çağrısı gerekmez. `fileIdx` yoksa `-1` gönderilir. `tr` değerleri stream'in `sources` dizisindeki `tracker:`/`dht:` ile başlayan girdilerdir.
2. **Relay:** yerel Stremio yoksa ve odada relay açıksa kullanıcı relay ister. İzin verilirse `/relay/<roomId>/<relayKey>/<infoHash>/<fileIdx>` kullanılır. Oda sayfasıyla aynı origin olduğu için CORS sorunu yoktur.
3. **Hiçbiri:** sadece sohbet ve durum çalışır. "Stremio'yu aç" uyarısı çıkar ve 3 sn'de bir yeniden yoklanır. Relay kapalıysa "host'tan relay iste" butonu gösterilir.

HTTP stream'ler doğrudan `url` ile oynatılır.

Chrome/Edge, internetteki bir sayfanın localhost'a erişmesi için "yerel ağ erişimi" izni isteyebilir. Sayfa izin reddedilmiş/beklenmekte durumunu yakalayamazsa bile "Tarayıcı izin sorarsa İzin ver'e basın" açıklamasını Stremio uyarısının yanında gösterir.

### 7.2 Uyumlu mod (dönüştürme)

- Önce doğrudan oynatılır. `<video>` hata verirse (`MEDIA_ERR_SRC_NOT_SUPPORTED`/`MEDIA_ERR_DECODE`) ya da stream `notWebReady` ise Stremio'nun HLS dönüştürme ucu kullanılır.
- Uç biçimleri (spike ile doğrulandı):
  - torrent: `<taban>/<infoHash>/<fileIdx>/hls.m3u8`
  - HTTP: `<taban>/url/<encodeURIComponent(url)>/hls.m3u8`

  Alt playlist ve segment yolları göreli olduğu için aynı yapı `/relay/...` öneki arkasında da çalışır.
- Oynatıcı seçimi:
  - Kaynak aynı origin'deyse (relay) `hls.js` kullanılır.
  - Kaynak misafirin yerel Stremio'suysa `hls.js` CORS yüzünden çalışamaz. Bu durumda tarayıcı HLS'i yerel olarak destekliyorsa (`video.canPlayType('application/vnd.apple.mpegurl')`: Safari, iOS, Android Chrome) doğrudan `<video src>` kullanılır. Desteklemiyorsa relay'e geçilir. Relay yoksa "Tarayıcın bu dosyayı açamıyor, başka stream seç" mesajı gösterilir.
  - Host kendi PC'sindeki Stremio için de relay yolunu kullanır. Host'un relay kullanımı `relayLimit`'e sayılmaz.
- Desteklenmeyen ses codec'i (AC3/DTS) hata üretmeden sessiz oynayabildiği için elle kullanılacak bir "Ses yok / oynamıyor → uyumlu mod" butonu da vardır.

### 7.3 Durum raporu

Her istemci 2 sn'de bir sunucuya `status` gönderir: `{state, source, drift, duration, quality}`.

- `state`: `idle` (kaynak yok), `loading`, `ready`, `buffering`, `error`, `noStremio`
- `source`: `local`, `relay`, `http`, `none`

`buffering`/`ready` geçişleri 2 sn beklenmeden hemen gönderilir.

- Kaynak yüklendikten sonra 60 sn içinde oynatılabilir veri gelmezse `error` durumuna geçilir. Host'a "stream başlamıyor, başka stream seç" önerisi gösterilir.

## 8. Senkron

### 8.1 Model

Sunucu tek doğru kaynaktır:

```
playback = { paused: boolean, position: number (sn), updatedAt: number (sunucu ms) }
```

Beklenen konum: `paused ? position : position + (sunucuŞimdi − updatedAt) / 1000`.

- **Saat farkı:** istemci katılınca 5 kez `time` ping'i atar. En düşük RTT'li örnekten sunucu saat farkı hesaplanır, 60 sn'de bir tazelenir.
- **Sapma düzeltme** (her 1 sn):
  - |fark| > 1.5 sn → `currentTime` beklenen konuma atanır (seek).
  - 0.3 sn < |fark| ≤ 1.5 sn → `playbackRate` 0.95 veya 1.05 yapılır. |fark| ≤ 0.3 sn olunca 1.0'a döner.
- Hesap fonksiyonları `public/js/sync-core.js` içinde saf fonksiyonlardır. Hem tarayıcı hem testler aynı dosyayı kullanır.

### 8.2 Kontrol yetkisi

- Oda ayarı `locked`. `true` iken oynat/duraklat/sar sadece host'a açıktır. Varsayılan `true`.
- Kilitli odada misafirin kontrolleri pasif görünür. Sunucu yetkisiz `control` olaylarını reddeder.
- Odanın stream'ini değiştirmek, altyazı seçmek ve oda ayarları kilitten bağımsız olarak her zaman sadece host'a açıktır.

### 8.3 Donma modları (`waitMode`, host ayarı, varsayılan `wait`)

**Beklenebilir kullanıcı:** bağlı, `state` değeri `loading` veya `buffering` ya da `ready` olan ve bu bekleme turunda host tarafından atlanmamış kullanıcı. `idle`, `noStremio` ve `error` durumundaki kullanıcılar kimseyi bekletmez.

- **`wait` (herkes beklesin):**
  - Oda oynarken beklenebilir bir kullanıcı `loading`/`buffering` durumuna düşerse sunucu odayı otomatik duraklatır (`autoPaused = true`) ve `waiting {userIds}` yayınlar. Arayüzde "Ali bekleniyor..." yazar.
  - Beklenen herkes `ready` olunca, `autoPaused` hâlâ `true` ise oda kaldığı yerden devam eder. Beklerken biri elle duraklatırsa `autoPaused` sıfırlanır ve otomatik devam olmaz.
  - Host "oynat"a bastığında beklenebilir herkes `ready` değilse oda aynı bekleme durumuna girer. Açılıştaki ön yükleme bu kuralla sağlanır.
  - Süre sınırı yoktur.
- **`continue` (beklemeden devam):** oda hiç otomatik durmaz. Donan kullanıcı listede ⏳ ile görünür, düzelince §8.1 kuralıyla oda zamanına sarılır.
- **Her iki modda:**
  - Bağlantısı kopan kişi beklenenlerden hemen çıkar.
  - Host bekleme sırasında "beklemeden devam et" diyebilir. O anda beklenen kullanıcılar bu bekleme turu için atlanır, oda devam eder. Atlanan kullanıcı bir sonraki `ready` durumunda tekrar beklenebilir hale gelir.

### 8.4 Mod ve ayar değişimi

Host ayarları (`locked`, `waitMode`, `relayEnabled`, `relayLimit`) odada anında değişir ve herkese yayılır. Yeni odaların varsayılanları panelden gelir.

## 9. Kişiye göre stream (kalite)

- Oda `hostStreamId` alanını tutar. Her kullanıcının bir `ownStreamId` alanı vardır: `null` ise host'un stream'ini izler.
- Kalite sekmesinde odanın stream listesi kalite etiketi ve boyutla gösterilir. Kullanıcı kendine başka stream seçebilir ya da "host'unkini izle"ye dönebilir.
- **Misafir listesi kısıtı:** misafirlere giden listede sadece `torrent` stream'ler ve host'un o an seçtiği `http` stream bulunur. Addon URL'lerindeki debrid anahtarları diğer HTTP linkleriyle sızmaz.
- Host stream'i değiştirirse sadece `ownStreamId = null` olan kullanıcılar yeni stream'e geçer. Oynatma konumu korunur.
- **Süre farkı uyarısı:** kullanıcının `duration` değeri host'unkinden 2 sn'den fazla farklıysa hem o kullanıcıya hem izleyici listesinde uyarı çıkar: "Bu sürüm farklı, senkron kayabilir".

## 10. Altyazı

### 10.1 Kaynaklar

- **Addon'lar:** ayarlı addon'lardan manifest'inde `subtitles` kaynağı olanlar kullanılır. OpenSubtitles v3 (`https://opensubtitles-v3.strem.io/manifest.json`) varsayılan ayarda eklidir.
  - Oda oluşturulurken `/subtitles/<type>/<id>.json` çekilir.
  - Oda oluşturulunca ve host stream değişince sunucu, host'un stream'i için video hash'ini host PC'deki Stremio'dan alır: `GET http://127.0.0.1:11470/opensubHash?videoUrl=<video adresi>` → `{error, result: {hash, size}}`. Torrent için video adresi §7.1'deki yerel adrestir, HTTP için `url`'dir. Sunucu sonra `/subtitles/<type>/<id>/videoHash=<hash>&videoSize=<size>.json` ile yeniden çeker. Eşleşen altyazılar "✓ bu dosyaya uygun" olarak işaretlenip üste alınır. Stremio kapalıysa ya da hash alınamazsa hash'siz liste kalır.
- **Stream'in kendi altyazıları:** host'un stream nesnesindeki `subtitles` dizisi listeye eklenir.
- **Dosya yükleme:** `.srt`/`.vtt`, en fazla 2 MB.
  - Host yüklerse dosya :7000 üzerindeki `POST /room/<roomId>/subtitles` ucuna `X-User-Token` başlığıyla gider. Sunucu token sahibinin o anki host olduğunu kontrol eder. Dosya oda silinene kadar RAM'de kalır ve herkese sunulabilir.
  - Misafir yüklerse dosya sadece kendi tarayıcısında kullanılır.

### 10.2 Liste ve sunum

- Liste dile göre gruplanır: önce Türkçe, sonra İngilizce, sonra diğer diller (alfabetik).
- İstemci altyazıyı her zaman `GET /sub/<roomId>/<subId>.vtt` ile alır. Sunucu kaynağı indirir, kodlamayı çözer, SRT ise VTT'ye çevirir ve sonucu oda boyunca RAM'de önbelleğe alır. Genel amaçlı açık proxy yoktur: sadece odanın listesindeki altyazılar indirilebilir.
- **Kodlama:**
  - BOM varsa temizlenir.
  - `TextDecoder('utf-8', {fatal: true})` başarılıysa UTF-8 kabul edilir.
  - Değilse dile göre eski kod sayfası seçilir: `tur` için windows-1254, `rus`/`ukr`/`bul` için 1251, `ell` için 1253, `heb` için 1255, `ara` için 1256, diğerleri için 1252.

### 10.3 Paylaşım ve ayarlar

- Host'un seçimi (`{subId, offset}` ya da kapalı) `subtitle` olayıyla herkese yayılır.
- Kendi başına farklı altyazı seçen ya da gecikmeyi değiştiren misafir "kişisel" moda geçer ve host değişikliklerinden etkilenmez. "Host'unkine dön" butonu senkrona geri alır.
- Gecikme ±0.5 sn adımlarla ayarlanır ve track'teki cue zamanları kaydırılarak uygulanır.
- Yazı boyutu ve arka plan her zaman kişiseldir (`::cue` CSS'i, `localStorage`).

## 11. Sohbet ve izleyici listesi

- **Sohbet:**
  - Düz metindir, `textContent` ile basılır (HTML yorumlanmaz).
  - En fazla 500 karakter. Kişi başı 5 sn'de en fazla 5 mesaj.
  - Son 200 mesaj odada tutulur, sonradan gelen görür.
  - Sistem mesajları: katıldı, ayrıldı, host değişti, stream değişti, altyazı değişti, atıldı.
- **İzleyici listesi:**
  - ad, host rozeti
  - durum simgesi (▶ oynuyor, ⏸, ⏳ yükleniyor/donuyor, ⚠ hata, 🚫 Stremio yok)
  - kaynak (yerel / 📶 relay / http), kalite
  - sapma (ms)
  - süre farkı uyarısı
- **Host işlemleri:** kişi atma. Atılan kişinin token'ı o odaya tekrar giremez.

## 12. Host devri ve oda ömrü

- Odayı oluşturan kişinin `userToken` değeri `creatorToken` olarak kaydedilir (§5).
- Host'un bağlantısı koparsa 30 sn beklenir. Geri gelirse host devam eder. Gelmezse host rolü en eski bağlı kullanıcıya geçer.
- Oda sahibi (creator) sonradan geri gelirse host'u geri alır.
- Oda boşalınca 5 dk sonra silinir. Panelden "odayı kapat" denirse hemen silinir, herkese "oda kapatıldı" gösterilir.
- Sunucu kapanınca tüm odalar kaybolur.

## 13. Relay: host üzerinden izle (`src/relay.js`)

- Adresler:
  - `/relay/:roomId/:relayKey/:infoHash/:fileIdx` → `127.0.0.1:11470/<infoHash>/<fileIdx>?tr=...` (`tr` değerleri sunucudaki stream kaydından eklenir, istemciden alınmaz)
  - `/relay/:roomId/:relayKey/:infoHash/:fileIdx/<hls yolu>` (uyumlu mod). `<hls yolu>` şu kalıplardan biri olmalıdır: `hls.m3u8`, `(video|audio|subtitle)\d+(\.m3u8)?`, bunların altında `init.mp4` veya `segment\d+\.(m4s|vtt)`.
  - HTTP stream'ler relay'den geçmez.
- **Kurallar:**
  - Oda relay'e açık olmalıdır (`relayEnabled`).
  - `relayKey` o odadaki relay izni verilmiş bir kullanıcıya ait olmalıdır. Anahtar kişiye özeldir, kullanıcı ayrılınca ya da atılınca geçersiz olur.
  - `infoHash` + `fileIdx` odanın stream listesindeki bir torrent stream'e ait olmalıdır.
  - Yol yukarıdaki kalıpların dışındaysa 404 döner. Stremio'nun diğer uçları (ayarlar, yerel dosya, `/proxy`, `/url/...` vb.) hiçbir koşulda aktarılmaz.
- **Kişi sınırı:** aynı anda relay izni olan kullanıcı sayısı `relayLimit` ile sınırlıdır (varsayılan 2). Host bu sayıya dahil değildir (§7.2). Sınır doluysa istek reddedilir, arayüzde "relay dolu" yazar.
- `Range` başlıkları aynen aktarılır, ileri sarma çalışır.
- Aktarılan bayt sayılır ve panelde oda/kişi bazında anlık Mbps olarak gösterilir.
- **Varsayılan:** `relayEnabled: true`, `relayLimit: 2`.
- **Uyarılar (arayüzde):**
  - Relay host'un upload hızını ve dönüştürme gerekirse işlemcisini kullanır. 1080p kişi başı ~5–10 Mbps ister.
  - Relay'deki kişi farklı bir stream seçerse o torrent de host PC'sinde indirilir.
- **Real-Debrid uyarısı:** host bir `http` stream seçtiğinde onay penceresinde şu açıklanır: "Bu linkte debrid hesabının anahtarı var. Arkadaşların senin hesabını kullanır. Real-Debrid farklı IP'lerden eşzamanlı kullanımı ban sebebi sayabilir."

## 14. Mobil

- Oda sayfası duyarlıdır (§6). Tek tasarım masaüstü ve mobili kapsar.
- Telefonda kaynak sırası §7.1'deki gibidir. Android'de Stremio uygulaması açıksa yerel sunucu denenir (S7'de doğrulanır). iPhone'da genelde relay kullanılır.
- iOS Safari arka plana alınınca video durur. Geri gelince `loading` → `ready` akışıyla oda zamanına yetişir.

## 15. Kontrol paneli — GUI (:7001)

### 15.1 Açılış

- `kurulum.bat` paketleri yükler, gerekirse `cloudflared`'i winget ile kurar ve masaüstüne "Birlikte İzle" kısayolu oluşturur. Kısayol `baslat.vbs` dosyasını çalıştırır.
- `baslat.vbs`:
  1. `http://127.0.0.1:7001/api/ping` yoklanır.
  2. Cevap yoksa `node server.js` konsol penceresi olmadan başlatılır ve ping cevap verene kadar (en fazla 15 sn) beklenir.
  3. `msedge --app=http://127.0.0.1:7001/` ile panel penceresi açılır.
- Pencereyi kapatmak sunucuyu kapatmaz. Paneldeki **Kapat** butonu sunucuyu ve tüneli durdurur. Aktif oda varsa önce onay sorar.

### 15.2 İçerik

- **Durum:**
  - sunucu
  - tünel: durum, URL, kopyala, yeniden başlat
  - Stremio: 11470 cevap veriyor mu
  - cloudflared: kurulu mu? Değilse **Kur** butonu `winget install Cloudflare.cloudflared` çalıştırır ve çıktıyı gösterir.
- **Eklentiyi kur:** `stremio://127.0.0.1:7000/manifest.json` linkiyle kurulum denenir. Çalışmazsa (S5) URL kopyalanır ve Stremio → Eklentiler → URL yapıştır adımları gösterilir.
- **Addon'lar:** ekle, sil, aç/kapat, sırala. "Test" butonu manifest'i çekip adını ve sağladığı kaynakları (stream/altyazı) gösterir.
- **Varsayılanlar:** kullanıcı adı, `waitMode`, `locked`, `relayEnabled`, `relayLimit`.
- **Aktif odalar:** içerik adı/poster, oda kodu, link kopyala, odayı kapat. Kişi başına durum, kaynak, kalite, sapma, relay Mbps ve "at" butonu gösterilir. 2 sn'de bir tazelenir.
- **Log:** son 100 olay/hata. Tam log `data/logs/server.log` dosyasındadır, 5 MB'ı geçince bir yedeğe döndürülür.

### 15.3 Panel API güvenliği

- :7001 sadece `127.0.0.1` adresine bağlanır.
- `Host` başlığı `127.0.0.1:7001` veya `localhost:7001` değilse istek reddedilir (DNS rebinding önlemi).
- Sunucu her açılışta rastgele bir panel anahtarı üretir ve panel/`/new` HTML'ine gömer. Tüm `/api/*` istekleri `X-Panel-Key` başlığı ister.
- Durum değiştiren isteklerde `Origin` başlığı `http://127.0.0.1:7001` olmalıdır (CSRF önlemi).

### 15.4 API

| Uç | Açıklama |
|---|---|
| `GET /api/ping` | Anahtarsız, sadece `ok`. `baslat.vbs` için. |
| `GET /api/status` | sunucu, tünel `{state, url}`, stremio, cloudflared |
| `POST /api/tunnel/restart` | |
| `POST /api/cloudflared/install` | |
| `GET /api/config`, `PUT /api/config` | doğrulamalı |
| `POST /api/addons/test {url}` | manifest özeti |
| `GET /api/streams?type&id` | §5 |
| `POST /api/rooms {type, id, streamId}` | §5 |
| `GET /api/rooms` | panel listesi |
| `POST /api/rooms/:id/close` | |
| `POST /api/rooms/:id/kick {userId}` | |
| `GET /api/logs` | |
| `POST /api/shutdown` | |

## 16. Tünel (`src/tunnel.js`)

- `cloudflared tunnel --url http://127.0.0.1:7000 --no-autoupdate` alt süreç olarak başlatılır.
- cloudflared önce PATH'te, sonra winget'in varsayılan kurulum yolunda aranır.
- Çıktıdan `https://[a-z0-9-]+\.trycloudflare\.com` yakalanır.
- Durumlar: `missing` (kurulu değil), `starting`, `up`, `down`.
- Süreç kapanırsa 5 sn, 15 sn, 60 sn aralıklarla yeniden başlatılır. Sonra her 60 sn'de bir denenir.
- Tünel yeniden başlayınca URL değişir ve tünel üzerinden bağlı misafirlerin bağlantısı kopar. Yerel bağlı host'a `publicUrl` olayı gider. Oda sayfası "Link değişti, yeni linki paylaş" uyarısı gösterir, "Link kopyala" yeni adresi verir. Oda ve durumu korunur, misafirler yeni linkle aynı odaya döner.

## 17. Veri modeli

```js
// data/config.json
{
  nickname: "recep",
  addons: [{ url, name, enabled, resources: ["stream"|"subtitles"] }],
  defaults: { locked: true, waitMode: "wait" /* | "continue" */, relayEnabled: true, relayLimit: 2 }
}

// RAM
Room = {
  id, createdAt, type, contentId, meta: { name, poster },
  creatorToken, hostUserId,
  settings: { locked, waitMode, relayEnabled, relayLimit },
  streams: [NormalizedStream], hostStreamId,
  subtitles: [{ subId, lang, label, source: "addon"|"stream"|"upload", url?, matched, vttCache? }],
  hostSubtitle: { subId, offset } | null,
  playback: { paused, position, updatedAt },
  autoPaused, waitingUserIds, skippedUserIds,
  users: Map<userId, User>, bannedTokens: Set,
  chat: [ { from, text, ts, system } ]  // son 200
}

User = {
  id, token, name, socketId, connected, joinedAt, disconnectedAt,
  ownStreamId, relayKey, status: { state, source, drift, duration, quality }, updatedAt
}

NormalizedStream = {
  streamId, kind: "torrent"|"http", addonName, title, quality, sizeBytes,
  infoHash?, fileIdx?, sources?, url?, notWebReady, subtitles?
}
```

## 18. Socket olayları (:7000, Socket.IO)

İstemci → sunucu (tümü ack döner, `{ok}` veya `{error}`):

| Olay | Yük | Kural |
|---|---|---|
| `join` | `{roomId, userToken, name}` | ack: oda anlık görüntüsü + `you` |
| `time` | — | ack: sunucu ms |
| `control` | `{action: "play"\|"pause"\|"seek", position}` | kilitliyse sadece host |
| `status` | `{state, source, drift, duration, quality}` | |
| `chat` | `{text}` | hız sınırı |
| `setOwnStream` | `{streamId \| null}` | |
| `setHostStream` | `{streamId}` | sadece host |
| `setHostSubtitle` | `{subId \| null, offset}` | sadece host |
| `settings` | kısmi `settings` | sadece host |
| `skipWaiting` | — | sadece host |
| `kick` | `{userId}` | sadece host |
| `requestRelay`, `releaseRelay` | — | ack: `{relayKey}` ya da hata |

Sunucu → istemci: `playback`, `users`, `waiting`, `chat`, `hostStream`, `subtitles`, `hostSubtitle`, `settings`, `hostChanged`, `publicUrl`, `kicked`, `roomClosed`.

Genel sınırlar:
- `status` olayları `users` yayınını tetikler. Bu yayın oda başına saniyede en fazla 1 kez gönderilir. `buffering`/`ready` geçişleri ve `waiting` bu sınıra takılmaz.
- Bağlantı başına saniyede en fazla 20 olay.
- IP başına (`cf-connecting-ip`, yoksa soket adresi) dakikada en fazla 10 başarısız `join`.
- Oda id'si 6 karakterdir. 31 karakterlik alfabeden (A–Z ve 2–9) rastgele üretilir, karışan karakterler (0/O, 1/I/L) çıkarılmıştır.

## 19. Hata durumları

| Durum | Davranış |
|---|---|
| Misafirde Stremio kapalı | `noStremio`. Uyarı gösterilir, 3 sn'de bir yeniden yoklanır, relay önerilir. |
| Tarayıcı dosyayı açamıyor | Uyumlu moda (HLS) otomatik geçilir. "Ses yok" butonu da var. |
| Torrent 60 sn başlamıyor | `error`. Host'a stream değiştirme önerilir. |
| Addon hata / zaman aşımı | Stream listesinde addon adıyla hata gösterilir, diğerleri listelenir. |
| Cinemeta hatası | Başlık yerine id gösterilir. |
| Altyazı indirilemiyor | Sadece o altyazı "yüklenemedi" olarak işaretlenir. |
| Host bağlantısı koptu | §12 |
| Misafir bağlantısı koptu | Socket.IO otomatik yeniden bağlanır, `join` tekrarlanır, anlık görüntü alınır. |
| Tünel koptu / URL değişti | §16. Yerel host etkilenmez. |
| cloudflared kurulu değil | Panelde `missing` + Kur butonu. Oda yine açılır ama link paylaşılamaz. |
| Relay dolu / kapalı | İstek reddedilir, arayüzde sebep yazar. |
| Oda bulunamadı | "Oda yok veya kapandı" sayfası gösterilir. |

## 20. Klasör yapısı

```
stremio-birlikte-izle/
  package.json            "type": "module"; bağımlılıklar: express, socket.io, hls.js; dev: socket.io-client
  server.js               iki HTTP sunucusu + Socket.IO + tünel başlatma
  src/
    config.js             yükle/doğrula/kaydet
    log.js                dosya + bellek içi son 100
    addon.js              manifest, /stream, /configure
    addons-client.js      addon stream/altyazı/manifest çekme, Cinemeta
    streams.js            normalizasyon, kalite/boyut, misafir filtresi
    rooms.js              oda durum makinesi (saf; saat dışarıdan verilir)
    socket.js             socket olayları ↔ rooms.js
    relay.js              izinli proxy, bayt sayacı
    subtitles.js          indirme, kodlama, SRT→VTT, önbellek
    stremio-local.js      11470 yoklama, torrent kaydetme (relay için)
    tunnel.js             cloudflared yönetimi
    panel-api.js          :7001 uçları, güvenlik ara katmanı
  public/                 :7000
    room.html
    css/room.css
    js/room.js  js/player.js  js/sync-core.js  js/sync.js  js/subs.js  js/chat.js  js/users.js
  panel/                  :7001
    index.html  new.html
    css/panel.css
    js/panel.js  js/new.js
  test/
  baslat.vbs
  kurulum.bat
  docs/superpowers/specs/
```

`hls.js` CDN'den değil `node_modules/hls.js/dist/hls.min.js` dosyasından `/vendor/hls.min.js` olarak sunulur.

## 21. Test

### 21.1 Spike

Stremio masaüstünün kurulu `server.js` kaynağı incelenerek yapıldı (2026-09-11).

| # | Soru | Sonuç |
|---|---|---|
| S1 | 11470'e tarayıcıdan CORS'lu erişim | **Yok.** CORS sadece Stremio alan adları ve `peario.xyz` için açık. Tasarım `no-cors` yoklama + `<video src>` + sunucu tarafı çağrılar olarak düzeltildi (§7.1). Yerel ağ erişimi izni davranışı elle testte görülecek. |
| S2 | Torrent oynatma uçları | `GET /<infoHash>/<fileIdx>?tr=...` torrent'i kendisi başlatır. `fileIdx` yoksa `-1`. Ayrı `create` gerekmez. |
| S3 | HLS dönüştürme | `/<infoHash>/<fileIdx>/hls.m3u8` ve `/url/<url>/hls.m3u8`, göreli alt yollar. Relay öneki arkasında çalışır. `hls.js` sadece aynı origin'de (§7.2). |
| S4 | Video hash ucu | `GET /opensubHash?videoUrl=<url>` → `{error, result}`. Sunucu tarafından çağrılır (§10.1). |
| S5 | `externalUrl: http://127.0.0.1:7001/...` tarayıcıda açılıyor mu, `stremio://` kurulum linki | Elle testte doğrulanacak. |
| S6 | Stremio'nun `http://127.0.0.1:7000/manifest.json` adresini kabul etmesi | Elle testte doğrulanacak. |
| S7 | Android Stremio uygulamasının yerel sunucusu | Elle testte doğrulanacak. Yoksa relay kullanılır. |
| S8 | trycloudflare üzerinden WebSocket ve Range'li video | Elle testte doğrulanacak. |

### 21.2 Otomatik testler (`node:test`, `npm test`)

- `rooms.test.js`:
  - kilit yetkisi
  - `wait` modu: otomatik duraklama, herkes hazır olunca devam, elle duraklatınca otomatik devam yok, bağlantı kopunca bekleme listesinden çıkma, `skipWaiting`
  - `continue` modu: hiç durmama
  - host devri: 30 sn, en eski kullanıcı, creator'ın geri alması
  - atma + tekrar girememe
  - oda silinme süresi
  - host stream değişince takipçilerin geçmesi
- `sync-core.test.js`: beklenen konum, saat farkı tahmini, sapma → seek/rate kararı.
- `streams.test.js`: normalizasyon, kalite/boyut ayrıştırma, misafir listesi filtresi (HTTP linkleri sızmıyor).
- `subtitles.test.js`: SRT→VTT, BOM, UTF-8 / windows-1254 tespiti (ğ, ş, ı, İ örnekleri), dil sıralama.
- `relay.test.js`: izinsiz infoHash, geçersiz anahtar, kişi sınırı, yasak Stremio uçları, Range aktarımı (sahte 11470 sunucusuyla).
- `config.test.js`: doğrulama, varsayılanlar, bozuk dosya.
- `panel-api.test.js`: yanlış `Host`, anahtarsız istek, yanlış `Origin` reddi; oda oluşturma, listeleme, kapatma, atma.
- `addon.test.js`: manifest, `/stream` yanıtı (film ve dizi id'si).
- `socket.test.js` (entegrasyon): gerçek sunucu + iki `socket.io-client` ile katılma, `control` yayılması, kilit reddi, `wait` akışı, sohbet hız sınırı.

Addon ve Cinemeta çağrıları testlerde sahte fetch ile yapılır. Gerçek ağa çıkılmaz.

### 21.3 Elle kontrol listesi

Gerçek Stremio + masaüstü tarayıcı (normal + gizli pencere) + tünel + telefon (Android, varsa iPhone):
- panelden kurulum
- oda açma
- senkron
- donma modları
- kalite değiştirme
- altyazı (Türkçe karakterler)
- relay
- host çıkışı
- tünel yeniden başlatma
- Kapat butonu

## 22. Uygulama sırası

Her aşama tek başına kullanılabilir bir sürüm verir. Tek uygulama planında aşamalar halinde yazılır.

0. **Spike** (§21.1). Tamamlandı.
1. **Çekirdek:**
   - config, log, addon, streams, addons-client
   - rooms + socket: senkron, kilit, iki donma modu, host devri, sohbet, izleyici listesi
   - oda sayfası: yerel Stremio ve HTTP kaynağıyla
   - panel: durum, addon'lar, varsayılanlar, odalar, log, kapat
   - tünel, `baslat.vbs`, kısayol
2. **Altyazı** (§10).
3. **Kişiye göre stream + süre farkı uyarısı** (§9).
4. **Relay + mobil düzen** (§13, §14).
5. **Uyumlu mod (HLS)** (§7.2). Yerel ve relay kaynağıyla.

## 23. Kapsam dışı (ilk sürüm)

- MKV içine gömülü altyazılar
- sesli/görüntülü sohbet, emoji tepkileri
- oda şifresi
- misafirlerin oda açması
- kalıcı odalar
- Stremio hesabıyla giriş
- Safari masaüstü garantisi
- Windows ile otomatik başlatma, tepsi ikonu
- katalog
- sabit alan adı

## 24. Uygulamada verilen kararlar

Uygulama sırasında spec'ten ayrılan ya da spec'i netleştiren noktalar:

- **Kurulum:** `kisayol-olustur.bat` yerine tek bir `kurulum.bat` var. `npm install` ve `cloudflared` kurulumunu da yapıyor. Panel sayfaları sıkı bir CSP ile sunuluyor.
- **Host'un adı:** oda linki `#host=<token>&name=<paneldeki ad>` taşıyor. Katılma ekranında ad hazır dolu geliyor.
- **Relay:**
  - Host her zaman relay kullanabilir (`relayEnabled` ve `relayLimit`'ten muaf), çünkü host'un relay'i kendi Stremio'su. Ama kendi Stremio'su kapalıyken host relay'e düşmez, "Stremio açık değil" mesajını görür.
  - Misafir relay'i kullanmadan önce `GET /relay/:roomId/:relayKey/ping` ile host'un Stremio'sunun açık olup olmadığına bakar. Kapalıysa "Host'un Stremio'su şu an kapalı" gösterilir.
  - Relay, HLS master playlist istendiğinde torrent'i önce tracker'larıyla birlikte düz adresten "ısıtır". Böylece dönüştürücü torrent'i tracker'sız açmaz.
  - Ayar değişikliği (relay kapatma, sınır düşürme) en yeni izinleri geri alır ve ilgili kişilere `relayRevoked` gönderilir.
- **Uyumlu mod:**
  - HTTP (debrid) stream'ler sadece izleyicinin kendi Stremio'su ve tarayıcının yerel HLS desteği varsa dönüştürülür (relay HTTP stream taşımaz).
  - Uyumlu mod hiç kullanılamıyorsa durum `error`, sebep `compat` olur.
- **Altyazı "uygun" işareti:** OpenSubtitles hash'li ve hash'siz sorguda aynı listeyi farklı sırayla dönebildiği için:
  - "✓ bu dosyaya uygun" işareti sadece stream'in kendi altyazılarına ve yalnızca hash'li sorguda gelenlere konur.
  - Hash'li sonucun sırası liste sıralamasında kullanılır.
- **Stream normalizasyonu:** özel istek başlığı gerektiren (`behaviorHints.proxyHeaders`) HTTP stream'ler atılıyor, çünkü tarayıcı bunları oynatamaz.
- **Senkron ayrıntıları:**
  - Oynarken otomatik ileri sarma en fazla 4 sn'de bir yapılıyor. Böylece yavaş indiren biri sürekli sarma döngüsüne girmiyor.
  - `buffering` durumu 700 ms gecikmeyle bildiriliyor. Anlık takılmalar odayı durdurmuyor.
  - Kendi başlattığımız oynat/duraklat/sar olaylarından sonraki 1 sn içindeki medya olayları kullanıcı işlemi sayılmıyor. Diğerleri (PiP, medya tuşları, iOS oynatıcı) kilitli odada geri alınıyor, kilitsiz odada gönderiliyor.
- **Doğrulama (2026-09-11):**
  - 121 otomatik test geçiyor.
  - Gerçek Torrentio + Cinemeta + OpenSubtitles ile uçtan uca denendi: oda açma, katılma, kilit, "herkes beklesin", 39 altyazı, Türkçe karakterler.
  - Headless Edge'de oda sayfası, panel ve oda açma sayfası JavaScript hatası olmadan çalıştı.
  - Elle test edilecekler: S5–S8, gerçek Stremio ile oynatma, telefon, tünel.

## 25. Sonradan eklenenler (2026-09-11, kullanıcı geri bildirimiyle)

**Oynatma ve kalite**
- **Akıllı uyumlu mod:** Stremio'nun `/hlsv2/<id>/master.m3u8?mediaURL=…&videoCodecs=…&audioCodecs=…[&maxWidth=3840]` dönüştürücüsü kullanılıyor.
  - Tarayıcının açabildiği codec'ler `public/js/codecs.js` ile ölçülüp gönderiliyor. Stremio listede olanı olduğu gibi aktarıyor, olmayanı dönüştürüyor. Varsayılanları: video `h264`, ses `aac,mp3`, genişlik sınırı 1920.
  - Gerçek Stremio ile doğrulandı: HEVC → `hev1` olarak aktarıldı, AC3 → AAC'ye dönüştü.
  - Safari'de HEVC gönderilmiyor, çünkü Apple `hev1` biçimini kabul etmiyor.
- **Görüntü kalitesini koru** (varsayılan açık): görüntü asla yeniden kodlanmıyor, `videoCodecs` listesine H.264, HEVC ve AV1'in hepsi yazılıyor.
  - Tarayıcı görüntüyü çözemezse bir açıklama ekranı çıkıyor: "✅ dosya seç", "HEVC / donanım hızlandırma nasıl açılır" ya da "yine de dönüştür".
  - Tarayıcının açamadığı bilinen bir codec'te dosya hiç indirilmiyor.
- **4K dönüştürme izni:** izleyicide varsayılan açık. Relay'den izleyenler için oda ayarındaki `relay4k` gerekiyor, varsayılan kapalı. Relay bu kuralı kendisi uyguluyor.
- **Otomatik geçiş:** görüntü ya da ses gelmezse (ölçüm: `videoWidth`, `webkitAudioDecodedByteCount`) kurallara göre uyumlu moda geçiliyor.

**Relay**
- Dönüştürücü istekleri `/relay/:room/:key/hlsv2/:convertId/*` üzerinden geçiyor.
- Sunucu `convertId`'yi (akış + codec listesi + maxWidth özeti) ve `mediaURL`'yi kendisi yeniden hesaplıyor. Bilinmeyen parametreler reddediliyor (`validateHlsV2`).
- Eski `/<ih>/<idx>/hls.m3u8` yolu kaldırıldı.

**Bilgi**
- **Stream bilgisi:** `videoRisk` (HEVC/Dolby Vision/AV1), `hdr`, `seeders` (Torrentio 👤) ve `embeddedSubs` (dosya adındaki "Sub (…)", "ESub", "Multi Subs") ayrıştırılıyor.
- **Torrent istatistikleri:** host PC'deki Stremio'dan 3 sn'de bir `/<ih>/<idx>/stats.json` okunuyor (peer sayısı, gerçek hız) ve `torrentStats` olayıyla odaya yayılıyor. Diğer izleyicilerin hızı tarayıcı tahmini (tampon büyümesi × dosya bit hızı).
- **Oynatıcı sol üstü:** ekrandaki çözünürlük, dönüşüm ("2160p HEVC → 1080p H.264"), kaynak sayısı, boyut, bağlı peer, anlık ve gereken hız. Altında izleyici listesi.
- **Kalite listesi:** "2160p" altında gereken Mbps, 👤 kaynak ve 💾 boyut. Tarayıcıya göre ✅/⚠️, 🌗 HDR ve 💬 gömülü altyazı simgeleri. Açıklamalar ⓘ rozetinin arkasında.
- **Donanım hızlandırma kontrolü:** WebGL renderer adı ve `mediaCapabilities` ile yapılıyor (`public/js/hwaccel.js`).
- **Hız testi:** isteğe bağlı, `speed.cloudflare.com` üzerinden (CSP `connect-src`'ye eklendi).

**Görüntü ve arayüz**
- **Görüntü ayarı:** parlaklık %20–400, kontrast %20–300, renk %0–300. Sadece filme uygulanıyor: `<video>` elemanı görüntü boyutuna oturtuluyor, barlar etkilenmiyor. Oran butonu: Sığdır / Doldur / Uzat / 16:9 / 4:3 / 21:9.
- **Altyazı:** tarayıcının kendi `::cue` sistemi yerine oynatıcı üstündeki ayrı bir katmanda çiziliyor (`getCueAsHTML`), filtrelerden etkilenmiyor. iOS'un kendi tam ekranında tarayıcı altyazısı kullanılıyor. Ayarlar: boyut, konum, arka plan, kenarlık (Yok/İnce/Kalın/Gölge), gecikme. "Listeyi yenile" ve "Tekrar yükle" butonları var.
- **Diğer:** sohbette emoji seçici, yeniden boyutlanan yan panel, mobil taşma düzeltmesi, uyumlu mod butonu kontrollerle birlikte kayboluyor.

**Kararlılık**
- Tünel: `api.trycloudflare.com` artık tünel adresi sanılmıyor, cloudflared hata satırları log'a yazılıyor.
- Addon istekleri: önce IPv4, bekleyerek bir kez tekrar deneme, ağ hatasının sebebi log'da.
- Panel ayrı bir boş Edge profilinde (`data\edge-panel`) açılıyor. `NO_TUNNEL=1` yerel test sunucusu için.

**Açık konular**
- Dolby Vision profil 5 renkleri ve HDR→SDR'nin karanlık görünmesi tarayıcıda kökten çözülemiyor. Stremio uygulaması bunu mpv'nin ton eşlemesiyle yapıyor. Tam çözüm mpv tabanlı bir yardımcı oynatıcı olur, bu ayrı ve büyük bir iş.
