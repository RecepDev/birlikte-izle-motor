package xyz.birlikteizle.mobil

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// Telefonun video önbelleği boyutu (GB, ana ekranda elle; 0 = kapalı). İzlenen yerler telefonda kalır:
// aynı film ya da yarım kalan yer yeniden açılınca internete gitmeden gelir.
// - Stremio'suz motor açıksa (Motor.kt) onun önbelleği,
// - telefonda Stremio kullanılıyorsa Stremio'nun kendi ayarı (cacheSize). Android Stremio'da varsayılan
//   0: önbellek kapalı. Kişi bir değer girmediyse Stremio'nun ayarına dokunulmuyor.
object Onbellek {
    private const val ANAHTAR = "onbellekGb"
    const val VARSAYILAN_GB = 2f
    private const val GB = 1024L * 1024 * 1024

    private fun kayit(ctx: Context) = ctx.getSharedPreferences("ayar", Context.MODE_PRIVATE)

    fun gb(ctx: Context): Float = kayit(ctx).getFloat(ANAHTAR, VARSAYILAN_GB)
    fun girildiMi(ctx: Context) = kayit(ctx).contains(ANAHTAR)

    fun kaydet(ctx: Context, gb: Float) {
        kayit(ctx).edit().putFloat(ANAHTAR, gb).apply()
    }

    fun yazi(gb: Float): String = when {
        gb <= 0f -> "Kapalı"
        gb % 1f == 0f -> "${gb.toInt()} GB"
        else -> "$gb GB"
    }

    // Arka plan iş parçacığında: ayarı o an kullanılan motora uygular.
    fun uygula(ctx: Context) {
        val gb = gb(ctx)
        if (Motor.calisiyor()) {
            Motor.onbellekSiniri(gb)
            return
        }
        if (!girildiMi(ctx)) return
        runCatching {
            val c = URL("http://127.0.0.1:11470/settings").openConnection() as HttpURLConnection
            c.connectTimeout = 2000
            c.readTimeout = 5000
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(JSONObject().put("cacheSize", (gb * GB).toLong()).toString().toByteArray()) }
            c.responseCode
            c.disconnect()
        }
    }
}
