package xyz.birlikteizle.mobil

import android.annotation.SuppressLint
import android.app.PictureInPictureParams
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.media.MediaCodecList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

// Oda ekranı. Masaüstü istemcisinin telefondaki karşılığı:
//  - Oda sayfası (sohbet, kalite, altyazı, senkron) WebView'de olduğu gibi açılıyor.
//  - Sayfadaki <video> yerine ExoPlayer oynatıyor (kopru.js). ExoPlayer HEVC/HDR/AC3'ü
//    telefonun donanımıyla açıyor; tarayıcıdaki gibi dönüştürmeye gerek yok.
//  - Masaüstünden farkı: Android'de HTML videonun üstüne çizilebiliyor. Video WebView'in
//    arkasında, sayfanın video alanı saydam; kontroller ve altyazı sayfada kalıyor.
@SuppressLint("SetJavaScriptEnabled")
class OdaActivity : AppCompatActivity() {

    companion object {
        const val URL = "url"
        private const val DURUM_MS = 200L
    }

    private lateinit var web: WebView
    private lateinit var oynaticiGorunum: PlayerView
    private lateinit var oynatici: ExoPlayer
    private val ana = Handler(Looper.getMainLooper())
    private var odaUrl = ""
    private var tamEkran = false
    private var yuklendi = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        odaUrl = intent.getStringExtra(URL) ?: return finish()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Kısıtlı donanım çözücüsü olan telefonlarda yazılım çözücüye düşebilsin.
        val renderers = DefaultRenderersFactory(this).setEnableDecoderFallback(true)
        // Telefondaki Stremio'dan parça parça oku (bkz. ParcaliKaynak); diğer adresler aynen.
        val http = androidx.media3.datasource.DefaultHttpDataSource.Factory().setAllowCrossProtocolRedirects(true)
        val kaynak = androidx.media3.datasource.DataSource.Factory { ParcaliKaynak(http.createDataSource()) }
        oynatici = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(androidx.media3.exoplayer.source.DefaultMediaSourceFactory(kaynak))
            .build()
        // Ekran kapanınca da ses sürsün: işlemci ve Wi-Fi uyanık kalıyor.
        oynatici.setWakeMode(C.WAKE_MODE_NETWORK)
        oynatici.addListener(dinleyici)
        // Gömülü altyazılar kapalı başlasın: odanın altyazısını sayfa çiziyor, gömülüyü
        // ancak kişi seçerse açıyoruz.
        oynatici.trackSelectionParameters = oynatici.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()

        oynaticiGorunum = PlayerView(this).apply {
            useController = false
            player = oynatici
            setShutterBackgroundColor(Color.BLACK)
            subtitleView?.visibility = View.GONE // altyazıyı sayfa çiziyor
            visibility = View.INVISIBLE
        }
        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            addJavascriptInterface(Kopru(), "AndroidKopru")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    // Belge başında çalıştırma desteklenmiyorsa burada kuruyoruz.
                    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) kopruEnjekte()
                }

                // Oda sayfasına ulaşılamadıysa (sunucu kapalı, tünel adresi eskimiş, internet yok)
                // boş/hata sayfasında kalmasın: açılış ekranına dönülsün.
                override fun onReceivedError(view: WebView, istek: WebResourceRequest, hata: android.webkit.WebResourceError) {
                    if (istek.isForMainFrame) acilisaDon("Sunucuya ulaşılamadı (${hata.description}). Sunucu kapalı olabilir.")
                }

                override fun onReceivedHttpError(view: WebView, istek: WebResourceRequest, cevap: android.webkit.WebResourceResponse) {
                    if (istek.isForMainFrame && cevap.statusCode >= 500) acilisaDon("Sunucuya ulaşılamadı (${cevap.statusCode}). Sunucu kapalı ya da adresi değişmiş olabilir.")
                }

                // Oda dışındaki bağlantılar (yardım vb.) tarayıcıda açılsın.
                override fun shouldOverrideUrlLoading(view: WebView, istek: WebResourceRequest): Boolean {
                    val hedef = istek.url
                    if (hedef.host == Uri.parse(odaUrl).host) return false
                    // "Stremio'ya bağlan": Stremio açılıp yayın sunucusu ayağa kalkınca uygulamaya
                    // kendiliğinden geri dön (sayfa bağlantıyı zaten kendisi kuruyor).
                    if (hedef.scheme == "stremio") {
                        runCatching { startActivity(Intent(Intent.ACTION_VIEW, hedef)) }
                        stremioAcilincaDon()
                        return true
                    }
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, hedef)) }
                    return true
                }
            }
        }
        val kok = FrameLayout(this)
        kok.addView(oynaticiGorunum, FrameLayout.LayoutParams(1, 1))
        kok.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(kok)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    tamEkran -> js("window.__kopru && window.__kopru.tamEkranCik()")
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })

        // Köprü betiği host'un sunucusundan: düzeltmeler APK kurmadan gelsin. Ulaşılamazsa
        // uygulamadaki kopya. Sayfa ancak betik hazır olunca yükleniyor (belge başında çalışmalı).
        val sunucu = Uri.parse(odaUrl).let { "${it.scheme}://${it.authority}" }
        thread {
            val uzak = Guncelleme.oku("$sunucu/indir/android/kopru.js")?.takeIf { it.contains("__kopru") }
            runOnUiThread {
                kopru = cihazBilgisi() + (uzak ?: assets.open("kopru.js").bufferedReader().use { it.readText() })
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    WebViewCompat.addDocumentStartJavaScript(web, kopru, setOf("*"))
                }
                web.loadUrl(odaUrl)
            }
        }
        Guncelleme.apkDenetle(this, sunucu)
        // Sunucunun ntfy konusu: tünel adresi değişince açılış ekranı yenisini oradan bulur.
        thread {
            val konu = Guncelleme.oku("$sunucu/kesif.json")?.let { runCatching { JSONObject(it).optString("konu") }.getOrNull() }
            if (!konu.isNullOrEmpty()) getSharedPreferences("ayar", MODE_PRIVATE).edit().putString("konu", konu).apply()
        }
        ana.post(durumDongusu)
    }

    private var kopru = ""
    private fun kopruEnjekte() = web.evaluateJavascript(kopru, null)

    // Telefonun çözebildiği en büyük HEVC/AV1 çözünürlüğü: sayfa "yalnızca bu cihazın
    // açabildikleri" filtresinde kullanıyor (Kalite sekmesi, varsayılan kapalı).
    private fun cihazBilgisi(): String {
        fun enBuyuk(mime: String): Int = runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
                .filter { !it.isEncoder && it.supportedTypes.any { t -> t.equals(mime, true) } }
                .maxOfOrNull { it.getCapabilitiesForType(mime).videoCapabilities.supportedHeights.upper } ?: 0
        }.getOrDefault(0)
        // Ses çözücüleri: yoksa sayfa o kaynakta uyarı gösteriyor (ses dönüştürülerek açılır).
        val cozuculer = runCatching {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
                .flatMap { it.supportedTypes.map { t -> t.lowercase() } }.toSet()
        }.getOrDefault(emptySet())
        val ses = JSONObject()
            .put("ac3", "audio/ac3" in cozuculer)
            .put("eac3", "audio/eac3" in cozuculer)
            .put("dts", "audio/vnd.dts" in cozuculer || "audio/vnd.dts.hd" in cozuculer)
            .put("truehd", "audio/true-hd" in cozuculer)
        val bilgi = JSONObject()
            .put("ses", ses)
            .put("kalite", getSharedPreferences("ayar", MODE_PRIVATE).getString("kalite", null) ?: JSONObject.NULL)
            .put("hevc", enBuyuk(MimeTypes.VIDEO_H265))
            .put("h264", enBuyuk(MimeTypes.VIDEO_H264))
            .put("av1", enBuyuk(MimeTypes.VIDEO_AV1))
        return "window.mobilCihaz = $bilgi;\n"
    }
    private fun js(kod: String) = web.evaluateJavascript(kod, null)

    // ---- ExoPlayer -> sayfa ------------------------------------------------------------

    private val durumDongusu = object : Runnable {
        override fun run() {
            durumYolla()
            ana.postDelayed(this, DURUM_MS)
        }
    }

    private fun durumYolla() {
        if (!yuklendi) return
        val sure = oynatici.duration
        val video = oynatici.videoSize
        val durum = JSONObject()
            .put("position", oynatici.currentPosition / 1000.0)
            .put("duration", if (sure == C.TIME_UNSET) JSONObject.NULL else sure / 1000.0)
            .put("paused", !oynatici.playWhenReady)
            .put("seeking", false)
            .put("rate", oynatici.playbackParameters.speed.toDouble())
            .put("width", video.width)
            .put("height", video.height)
            .put("cacheEnd", oynatici.bufferedPosition / 1000.0)
            .put("idle", oynatici.playbackState == Player.STATE_IDLE)
            .put("cacheStalled", oynatici.playbackState == Player.STATE_BUFFERING)
            .put("loaded", sure != C.TIME_UNSET)
        js("window.__kopru && window.__kopru.durum($durum)")
    }

    private var sesUyarildi = false
    private var denemeSayisi = 0

    private val dinleyici = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) {
            sesleriYolla()
            altyazilariYolla()
            sesDesteginiDenetle(tracks)
        }

        override fun onPlaybackStateChanged(durum: Int) {
            if (durum == Player.STATE_READY) denemeSayisi = 0
        }

        override fun onPositionDiscontinuity(eski: Player.PositionInfo, yeni: Player.PositionInfo, neden: Int) {
            if (neden == Player.DISCONTINUITY_REASON_SEEK) js("window.__kopru && window.__kopru.sarildi()")
        }

        override fun onPlayerError(hata: PlaybackException) {
            // Ağ koptuysa (Wi-Fi'dan mobil veriye geçiş, tünel sarsıntısı) kaldığı yerden
            // yeniden dene; sayfaya ancak üst üste başarısız olursa bildir.
            val agHatasi = hata.errorCode in PlaybackException.ERROR_CODE_IO_UNSPECIFIED..PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE
            if (agHatasi && denemeSayisi < 6) {
                denemeSayisi++
                val konum = oynatici.currentPosition
                ana.postDelayed({
                    oynatici.prepare()
                    oynatici.seekTo(konum)
                }, 1500L * denemeSayisi)
                return
            }
            val metin = JSONObject.quote(hata.errorCodeName)
            js("window.__kopru && window.__kopru.hata($metin)")
        }
    }

    // DTS gibi telefonun çözemediği ses: ExoPlayer hata vermeden sessiz oynatıyor.
    // Sayfaya bildiriyoruz; sayfa yalnızca sesi dönüştüren uyumlu moda geçiyor (görüntü aynen).
    private fun sesDesteginiDenetle(tracks: Tracks) {
        val sesler = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (sesler.isEmpty() || sesUyarildi) return
        val hicbiri = sesler.none { g -> (0 until g.length).any { g.isTrackSupported(it) } }
        if (hicbiri) {
            sesUyarildi = true
            js("window.__kopru && window.__kopru.sesDesteklenmiyor()")
        }
    }

    // Dosyanın içindeki (gömülü) altyazılar: sayfada seçilebilsin diye listeyi yolluyoruz.
    private fun altyazilariYolla() {
        val liste = JSONArray()
        var sira = 0
        for (grup in oynatici.currentTracks.groups) {
            if (grup.type != C.TRACK_TYPE_TEXT) continue
            for (i in 0 until grup.length) {
                val bicim = grup.getTrackFormat(i)
                liste.put(JSONObject()
                    .put("id", "$sira:$i")
                    .put("title", bicim.label ?: "")
                    .put("lang", bicim.language ?: "")
                    .put("active", grup.isTrackSelected(i)))
            }
            sira++
        }
        js("window.__kopru && window.__kopru.gomuluAltyazilar($liste)")
    }

    private fun sesleriYolla() {
        val liste = JSONArray()
        var sira = 0
        for (grup in oynatici.currentTracks.groups) {
            if (grup.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until grup.length) {
                val bicim = grup.getTrackFormat(i)
                liste.put(JSONObject()
                    .put("id", "$sira:$i")
                    .put("title", bicim.label ?: "")
                    .put("lang", bicim.language ?: "")
                    .put("active", grup.isTrackSelected(i)))
            }
            sira++
        }
        js("window.__kopru && window.__kopru.sesler($liste)")
    }

    // ---- sayfa -> ExoPlayer ------------------------------------------------------------
    // JavascriptInterface çağrıları ayrı iş parçacığında geliyor; oynatıcıya ana
    // iş parçacığından dokunmak zorunlu.

    inner class Kopru {
        @JavascriptInterface
        fun yukle(url: String) = ana.post {
            if (url.isEmpty()) return@post
            val oge = MediaItem.Builder().setUri(url)
            // Uyumlu mod HLS veriyor; adres .m3u8 ile bitmeyebiliyor.
            if (url.contains("m3u8")) oge.setMimeType(MimeTypes.APPLICATION_M3U8)
            oynatici.setMediaItem(oge.build())
            oynatici.prepare()
            yuklendi = true
            sesUyarildi = false
            denemeSayisi = 0
        }

        // Gömülü altyazı seç ("" = kapat). Gömülüyü ExoPlayer çiziyor, dış altyazıyı sayfa.
        @JavascriptInterface
        fun gomuluSec(id: String) = ana.post {
            val yeni = oynatici.trackSelectionParameters.buildUpon()
            if (id.isEmpty()) {
                yeni.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                oynaticiGorunum.subtitleView?.visibility = View.GONE
            } else {
                val (grupSira, iz) = id.split(":").map { it.toIntOrNull() ?: 0 }
                val grup = oynatici.currentTracks.groups.filter { it.type == C.TRACK_TYPE_TEXT }.getOrNull(grupSira)
                    ?: return@post
                yeni.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                    .setOverrideForType(TrackSelectionOverride(grup.mediaTrackGroup, iz))
                oynaticiGorunum.subtitleView?.visibility = View.VISIBLE
            }
            oynatici.trackSelectionParameters = yeni.build()
        }

        // Ekran parlaklığı (kaydırma hareketi): yalnızca bu pencere için, 0..1.
        @JavascriptInterface
        fun parlaklik(deger: Double) = ana.post {
            window.attributes = window.attributes.apply { screenBrightness = deger.toFloat().coerceIn(0.02f, 1f) }
        }

        @JavascriptInterface
        fun durdur() = ana.post {
            oynatici.stop()
            oynatici.clearMediaItems()
            yuklendi = false
        }

        @JavascriptInterface
        fun sar(saniye: Double) = ana.post { oynatici.seekTo((saniye * 1000).toLong()) }

        @JavascriptInterface
        fun oynat(deger: Boolean) = ana.post { oynatici.playWhenReady = deger }

        @JavascriptInterface
        fun hiz(deger: Double) = ana.post { oynatici.playbackParameters = PlaybackParameters(deger.toFloat()) }

        @JavascriptInterface
        fun ses(deger: Double) = ana.post { oynatici.volume = deger.toFloat().coerceIn(0f, 1f) }

        @JavascriptInterface
        fun sesSec(id: String) = ana.post {
            val (grupSira, iz) = id.split(":").map { it.toIntOrNull() ?: 0 }
            val gruplar = oynatici.currentTracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
            val grup = gruplar.getOrNull(grupSira) ?: return@post
            oynatici.trackSelectionParameters = oynatici.trackSelectionParameters.buildUpon()
                .setOverrideForType(TrackSelectionOverride(grup.mediaTrackGroup, iz))
                .build()
        }

        // Sayfadaki video alanı (CSS pikseli, görünür alana göre). Oynatıcı tam oraya oturur.
        @JavascriptInterface
        fun alan(x: Double, y: Double, w: Double, h: Double) = ana.post {
            val o = resources.displayMetrics.density
            val p = oynaticiGorunum.layoutParams as FrameLayout.LayoutParams
            val gen = (w * o).toInt().coerceAtLeast(1)
            val yuk = (h * o).toInt().coerceAtLeast(1)
            if (p.width != gen || p.height != yuk) {
                p.width = gen
                p.height = yuk
                oynaticiGorunum.layoutParams = p
            }
            // Kaydırmada yalnızca konum değişiyor: yeniden yerleşim yerine ucuz taşıma.
            oynaticiGorunum.x = (x * o).toFloat()
            oynaticiGorunum.y = (y * o).toFloat()
            oynaticiGorunum.visibility = if (w > 0 && h > 0) View.VISIBLE else View.INVISIBLE
        }

        // Görüntü oranı: Sığdır / Doldur (kırp) / Uzat. Sabit oranlar sığdır gibi davranır.
        @JavascriptInterface
        fun oran(mod: String) = ana.post {
            oynaticiGorunum.resizeMode = when (mod) {
                "fill" -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                "stretch" -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
        }

        // Host odayı kapattı: oynatmayı bırakıp açılış ekranına dön.
        @JavascriptInterface
        fun odaKapandi() = ana.post {
            oynatici.stop()
            finish()
        }

        // Tam ekran: yatay çevir, sistem çubuklarını gizle. Sayfa da oynatıcıyı ekrana yayıyor.
        @JavascriptInterface
        fun tamEkran(acik: Boolean) = ana.post { tamEkranUygula(acik) }

        // Odada kalite tercihi değişince açılış ekranı da aynısını göstersin.
        @JavascriptInterface
        fun kaliteYaz(kalite: String) {
            if (kalite in setOf("2160p", "1080p", "720p")) getSharedPreferences("ayar", MODE_PRIVATE).edit().putString("kalite", kalite).apply()
        }

        // ⋯ menüsü: "VLC'de aç" (VLC yoksa video açan başka uygulama) ve "indir".
        @JavascriptInterface
        fun harici(url: String, tur: String, ad: String) = ana.post {
            val adres = Uri.parse(url)
            if (tur == "indir") {
                runCatching {
                    val dosya = ad.ifBlank { "video" }.replace(Regex("[\\\\/:*?\"<>|]+"), " ").trim() + ".mkv"
                    val istek = android.app.DownloadManager.Request(adres)
                        .setTitle(ad.ifBlank { "Birlikte İzle" })
                        .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                        .setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, dosya)
                    (getSystemService(DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(istek)
                }.onSuccess { android.widget.Toast.makeText(this@OdaActivity, "İndirme başladı (bildirimlerde)", android.widget.Toast.LENGTH_SHORT).show() }
                    .onFailure { android.widget.Toast.makeText(this@OdaActivity, "İndirilemedi: ${it.message}", android.widget.Toast.LENGTH_LONG).show() }
                return@post
            }
            val niyet = Intent(Intent.ACTION_VIEW).setDataAndType(adres, "video/*").putExtra("title", ad)
            runCatching { startActivity(Intent(niyet).setPackage("org.videolan.vlc")) }
                .recoverCatching { startActivity(Intent.createChooser(niyet, "Şununla aç")) }
                .onFailure { android.widget.Toast.makeText(this@OdaActivity, "Videoyu açabilecek uygulama yok", android.widget.Toast.LENGTH_LONG).show() }
        }
    }

    private fun tamEkranUygula(acik: Boolean) {
        tamEkran = acik
        val kontrol = WindowInsetsControllerCompat(window, window.decorView)
        WindowCompat.setDecorFitsSystemWindows(window, !acik)
        if (acik) {
            kontrol.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            kontrol.hide(WindowInsetsCompat.Type.systemBars())
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            kontrol.show(WindowInsetsCompat.Type.systemBars())
            requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    // ---- resim içinde resim ------------------------------------------------------------
    // Uygulamadan çıkınca (ana ekran tuşu) video küçük pencerede sürer. PiP'de sayfa gizli,
    // oynatıcı pencereyi kaplıyor; dönünce sayfa oynatıcıyı yeniden yerine koyuyor.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (!yuklendi || !oynatici.playWhenReady || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val boyut = oynatici.videoSize
        val oran = if (boyut.width > 0 && boyut.height > 0) {
            // Android çok geniş/çok dar oranları reddediyor: 2.39'u aşmasın.
            Rational(boyut.width, boyut.height).takeIf { it.toFloat() in 0.42f..2.39f } ?: Rational(239, 100)
        } else {
            Rational(16, 9)
        }
        runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(oran).build()) }
    }

    override fun onPictureInPictureModeChanged(pip: Boolean, yeniAyar: Configuration) {
        super.onPictureInPictureModeChanged(pip, yeniAyar)
        if (pip) {
            web.visibility = View.INVISIBLE
            oynaticiGorunum.layoutParams = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
            oynaticiGorunum.x = 0f
            oynaticiGorunum.y = 0f
        } else {
            web.visibility = View.VISIBLE
            js("window.__kopru && window.__kopru.yenidenOlc()")
        }
    }

    private fun stremioAcilincaDon() {
        thread {
            val son = System.currentTimeMillis() + 30_000
            var hazir = false
            while (!hazir && System.currentTimeMillis() < son) {
                Thread.sleep(1000)
                hazir = Guncelleme.oku("http://127.0.0.1:11470/settings", 1500) != null
            }
            // Sunucu hazır olsa da olmasa da en geç 30 sn'de uygulamaya dön.
            Thread.sleep(if (hazir) 800 else 0)
            ana.post {
                runCatching {
                    startActivity(Intent(this, OdaActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
                }
            }
        }
    }

    private var donuldu = false
    private fun acilisaDon(mesaj: String) {
        if (donuldu || isFinishing) return
        donuldu = true
        android.widget.Toast.makeText(this, mesaj, android.widget.Toast.LENGTH_LONG).show()
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    override fun onDestroy() {
        ana.removeCallbacksAndMessages(null)
        oynatici.release()
        web.destroy()
        super.onDestroy()
    }
}
