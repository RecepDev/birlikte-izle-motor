package xyz.birlikteizle.mobil

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
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
        oynatici = ExoPlayer.Builder(this, renderers).build()
        oynatici.addListener(dinleyici)

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

                // Oda dışındaki bağlantılar (yardım vb.) tarayıcıda açılsın.
                override fun shouldOverrideUrlLoading(view: WebView, istek: WebResourceRequest): Boolean {
                    val hedef = istek.url
                    if (hedef.host == Uri.parse(odaUrl).host) return false
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, hedef)) }
                    return true
                }
            }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, kopruBetigi(), setOf("*"))
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

        web.loadUrl(odaUrl)
        ana.post(durumDongusu)
    }

    private fun kopruBetigi(): String = assets.open("kopru.js").bufferedReader().use { it.readText() }
    private fun kopruEnjekte() = web.evaluateJavascript(kopruBetigi(), null)
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

    private val dinleyici = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) = sesleriYolla()

        override fun onPositionDiscontinuity(eski: Player.PositionInfo, yeni: Player.PositionInfo, neden: Int) {
            if (neden == Player.DISCONTINUITY_REASON_SEEK) js("window.__kopru && window.__kopru.sarildi()")
        }

        override fun onPlayerError(hata: PlaybackException) {
            val metin = JSONObject.quote(hata.errorCodeName)
            js("window.__kopru && window.__kopru.hata($metin)")
        }
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

        // Tam ekran: yatay çevir, sistem çubuklarını gizle. Sayfa da oynatıcıyı ekrana yayıyor.
        @JavascriptInterface
        fun tamEkran(acik: Boolean) = ana.post { tamEkranUygula(acik) }
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

    override fun onDestroy() {
        ana.removeCallbacksAndMessages(null)
        oynatici.release()
        web.destroy()
        super.onDestroy()
    }
}
