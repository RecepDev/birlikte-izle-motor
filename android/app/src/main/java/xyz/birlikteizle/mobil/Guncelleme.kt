package xyz.birlikteizle.mobil

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

// Host'un sunucusundan güncelleme:
//  - kopru.js her açılışta sunucudan geliyor (çoğu düzeltme sayfada ve köprüde olduğu
//    için APK'yı yeniden kurmaya gerek kalmıyor); gelmezse uygulamadaki kopya kullanılıyor.
//  - APK yalnızca yerel kod değiştiyse: sürüm numarası büyükse sorup indiriyor.
object Guncelleme {

    // ntfy.sh'deki son duyurulan adres: host'un güncel tünel adresi (değişse bile bulunur).
    fun ntfyAdresi(konu: String?): String? {
        if (konu.isNullOrEmpty()) return null
        val metin = oku("https://ntfy.sh/$konu/json?poll=1&since=12h", 5000) ?: return null
        return metin.trim().lines().mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
            .lastOrNull { it.optString("event") == "message" }
            ?.optString("message")?.trim()
            ?.takeIf { it.startsWith("http") }
    }

    fun oku(adres: String, zamanAsimiMs: Int = 3000): String? = runCatching {
        val baglanti = URL(adres).openConnection() as HttpURLConnection
        baglanti.connectTimeout = zamanAsimiMs
        baglanti.readTimeout = zamanAsimiMs
        baglanti.useCaches = false
        baglanti.inputStream.bufferedReader().use { it.readText() }.also { baglanti.disconnect() }
    }.getOrNull()

    // elle: "Güncellemeleri denetle" düğmesi; o zaman "güncelsin" / hata da söyleniyor.
    fun apkDenetle(etkinlik: Activity, kok: String?, elle: Boolean = false) = thread {
        fun soyle(metin: String) {
            if (elle) etkinlik.runOnUiThread { Toast.makeText(etkinlik, metin, Toast.LENGTH_LONG).show() }
        }
        if (kok == null) return@thread soyle("Sunucu bulunamadı. Önce bir odaya gir ya da oda linkini yapıştır.")
        val bilgi = oku("$kok/indir/surum.json", 6000)?.let { runCatching { JSONObject(it) }.getOrNull() }
            ?: return@thread soyle("Sunucuya ulaşılamadı.")
        val uzak = bilgi.optLong("android", 0)
        val paket = etkinlik.packageManager.getPackageInfo(etkinlik.packageName, 0)
        val yerel = PackageInfoCompat.getLongVersionCode(paket)
        if (uzak <= yerel) return@thread soyle("Güncelsin (sürüm ${paket.versionName}).")
        etkinlik.runOnUiThread {
            if (etkinlik.isFinishing) return@runOnUiThread
            AlertDialog.Builder(etkinlik)
                .setTitle("Güncelleme var")
                .setMessage("Uygulamanın yeni sürümü hazır. İndirip kurulsun mu?")
                .setPositiveButton("İndir") { _, _ -> apkIndir(etkinlik, kok) }
                .setNegativeButton("Sonra", null)
                .show()
        }
    }

    private fun apkIndir(etkinlik: Activity, kok: String) {
        Toast.makeText(etkinlik, "Güncelleme indiriliyor…", Toast.LENGTH_SHORT).show()
        thread {
            val dosya = File(etkinlik.cacheDir, "guncelleme.apk")
            val basarili = runCatching {
                val baglanti = URL("$kok/indir/android/birlikte-izle.apk").openConnection() as HttpURLConnection
                baglanti.connectTimeout = 10_000
                baglanti.readTimeout = 30_000
                baglanti.inputStream.use { giris -> dosya.outputStream().use { giris.copyTo(it) } }
                baglanti.disconnect()
            }.isSuccess
            etkinlik.runOnUiThread {
                if (!basarili) {
                    Toast.makeText(etkinlik, "Güncelleme indirilemedi.", Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                val uri = FileProvider.getUriForFile(etkinlik, "${etkinlik.packageName}.dosyalar", dosya)
                etkinlik.startActivity(Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}
