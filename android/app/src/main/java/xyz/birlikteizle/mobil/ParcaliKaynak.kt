package xyz.birlikteizle.mobil

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener

// Telefondaki Stremio'dan (127.0.0.1:11470) okurken ucu açık aralık ("bytes=X-") yerine kapalı
// parçalar istiyor. Stremio ucu açık her istekte dosyayı indirme listesine bir kopya daha
// ekliyor ve silmiyor; ileri-geri sarmalarda kopyalar birikip indirmeyi yavaşlatıyordu.
// Oynatıcıya tek, kesintisiz bir akış gibi görünüyor. Dosyanın ilk isteği olduğu gibi geçiyor
// (Stremio'nun dosyanın kalanını arkadan indirmesi için bir kayıt yeterli).
// Masaüstü karşılığı: masaustu/electron/stremio-vekil.cjs.
@UnstableApi
class ParcaliKaynak(private val ic: HttpDataSource) : DataSource {
    private var spec: DataSpec? = null
    private var konum = 0L
    private var toplam = C.LENGTH_UNSET.toLong()
    private var dogrudan = true

    override fun addTransferListener(dinleyici: TransferListener) = ic.addTransferListener(dinleyici)

    override fun open(dataSpec: DataSpec): Long {
        val uri = dataSpec.uri
        val stremio = uri.host == "127.0.0.1" && uri.port == 11470 && DOSYA.matches(uri.path ?: "")
        val anahtar = uri.path ?: ""
        if (!stremio || dataSpec.length != C.LENGTH_UNSET.toLong() || gorulen.add(anahtar)) {
            dogrudan = true
            return ic.open(dataSpec)
        }
        dogrudan = false
        spec = dataSpec
        konum = dataSpec.position
        toplam = C.LENGTH_UNSET.toLong()
        try {
            parcaAc()
        } catch (e: Exception) {
            // Parçalı açılamadıysa eski yola dön: video yine de oynasın.
            runCatching { ic.close() }
            dogrudan = true
            return ic.open(dataSpec)
        }
        // Toplam boy okunamadıysa parçalı sürdürmek riskli: kapat, düz aç.
        if (toplam <= 0) {
            ic.close()
            dogrudan = true
            return ic.open(dataSpec)
        }
        return toplam - dataSpec.position
    }

    private fun parcaAc() {
        val s = spec ?: return
        ic.open(s.subrange(konum - s.position, PARCA))
        if (toplam < 0) {
            val aralik = ic.responseHeaders["Content-Range"]?.firstOrNull() ?: ic.responseHeaders["content-range"]?.firstOrNull()
            toplam = aralik?.substringAfter('/')?.toLongOrNull() ?: C.LENGTH_UNSET.toLong()
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (dogrudan) return ic.read(buffer, offset, length)
        var n = ic.read(buffer, offset, length)
        if (n == C.RESULT_END_OF_INPUT) {
            ic.close()
            if (toplam < 0 || konum >= toplam) return C.RESULT_END_OF_INPUT
            parcaAc()
            n = ic.read(buffer, offset, length)
        }
        if (n > 0) konum += n
        return n
    }

    override fun getUri(): Uri? = ic.uri

    override fun getResponseHeaders(): Map<String, List<String>> = ic.responseHeaders

    override fun close() = ic.close()

    companion object {
        private const val PARCA = 48L * 1024 * 1024
        private val DOSYA = Regex("^/[0-9a-fA-F]{40}/[^/]+$")
        private val gorulen = java.util.Collections.synchronizedSet(HashSet<String>())
    }
}
