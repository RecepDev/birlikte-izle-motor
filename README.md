# Birlikte İzle

Stremio için Peario benzeri birlikte izleme eklentisi. Stremio'da bir film ya da bölüm açınca stream listesinde **👥 Birlikte İzle** çıkar. Buna tıklayınca bir oda açılır. Oda linkini arkadaşlarına gönderirsin, oynatma herkeste senkron ilerler. Odada sohbet, izleyici listesi, altyazı ve kişiye göre kalite seçimi vardır.

Sunucu senin bilgisayarında çalışır ve Cloudflare hızlı tüneli ile internete açılır. Hesap açman gerekmez.

## Kurulum (bir kere)

1. [Node.js 20+](https://nodejs.org) kur.
2. Bu klasördeki `kurulum.bat` dosyasını çalıştır. Paketleri yükler, `cloudflared`'i kurar ve masaüstüne **Birlikte İzle** kısayolunu koyar.
3. Kısayolu aç. Panel penceresi açılır.
4. Panelde **Stremio'ya eklentiyi kur** bölümünden eklentiyi kur. Tek tıkla kurulmazsa adresi kopyala: Stremio → Eklentiler → arama kutusuna yapıştır → Yükle. Adres: `http://127.0.0.1:7000/manifest.json`
5. Panelde **Addon'lar** bölümüne Torrentio gibi stream addon'larının manifest adresini ekle. OpenSubtitles hazır ekli gelir.

## Kullanım

1. Masaüstündeki kısayolla paneli aç.
2. Stremio'da bir film aç, stream listesinden **👥 Birlikte İzle**'yi seç.
3. Açılan sayfada stream'i seç, oda açılır.
4. **🔗 Linki kopyala** ile linki arkadaşlarına gönder.

**İzleyenler için:**
- Herkesin bilgisayarında Stremio açık olmalı. Video her kişinin kendi Stremio'sundan oynar.
- Stremio'su olmayanlar, örneğin telefondan girenler, host açtıysa **host üzerinden izle** (relay) ile senin bilgisayarından izler. Bu senin upload hızını kullanır: 1080p kişi başı yaklaşık 5–10 Mbps.

**Oda ayarları (⚙️):**
- **Host kilidi:** oynatmayı sadece host kontrol eder.
- **Biri donarsa:** "herkes beklesin" ya da "beklemeden devam".
- **Relay:** açık/kapalı ve kişi sınırı.

## Bilinmesi gerekenler

- **Tünel adresi her açılışta değişir.** Oda linkini her seferinde panelden ya da odadan yeniden kopyala.
- **Tarayıcı izin isteyebilir.** Chrome/Edge "yerel ağdaki cihazlara erişim" izni sorabilir. İzin ver'e bas, yoksa sayfa Stremio'ya ulaşamaz.
- **Real-Debrid linkleri:** doğrudan link (debrid) stream'lerde linkte hesabının anahtarı vardır. Arkadaşların senin hesabını kullanır ve servis bunu farklı IP'lerden eşzamanlı kullanım olarak algılayıp ban sebebi sayabilir. Torrent stream'lerde bu risk yok.
- **Dosya açılmıyorsa:** tarayıcı bazı dosyaları (MKV/HEVC, AC3/DTS ses) doğrudan açamaz. Oynatıcıdaki 🛠 **Uyumlu mod** Stremio'nun dönüştürmesini kullanır.

## Geliştirme

```
npm install
npm test
npm start
```

- Paneli açmak için: `http://127.0.0.1:7001/`
- Loglar: `data/logs/`
- Ayarlar: `data/config.json`
- Tasarım: [docs/superpowers/specs/2026-09-11-birlikte-izle-design.md](docs/superpowers/specs/2026-09-11-birlikte-izle-design.md)
