package xyz.birlikteizle.mobil

import android.content.Context
import android.net.Uri
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.concurrent.thread

// Stremio'suz çalışma (telefon). Telefonda Stremio açık değilse TorrServer motoru açılıyor:
// - Program uygulamanın içinde: jniLibs/arm64-v8a/libtorrserver.so. Android yalnızca yerel
//   kütüphane klasöründeki dosyaları çalıştırmaya izin veriyor; build.gradle.kts derlerken indiriyor.
// - Önüne 11470'te Stremio'nun adreslerini taklit eden küçük bir HTTP katmanı oturuyor (sunucudaki
//   src/motor/stremio-taklidi.js'in karşılığı). Sayfa, köprü ve oynatıcı (ParcaliKaynak) hiç
//   değişmeden "telefondaki Stremio"yu kullanıyor sanıyor.
// Telefonda Stremio açıksa (11470 dolu) hiçbir şey yapılmıyor. arm64 olmayan telefonda program yok:
// eskisi gibi Stremio ya da host üzerinden izleme.
object Motor {
    private const val PORT = 11470
    private const val TS_PORT = 8097
    private const val TS = "http://127.0.0.1:$TS_PORT"
    private const val ETIKET = "Motor"
    private val VIDEO = Regex("\\.(mkv|mp4|avi|m4v|mov|wmv|ts|m2ts|webm|mpg|mpeg)$", RegexOption.IGNORE_CASE)
    private val DOSYA = Regex("^/([0-9a-fA-F]{40})/(-1|\\d+)$")
    private val ISLEM = Regex("^/([0-9a-fA-F]{40})/(stats\\.json|remove)$")

    // Video önbelleği (sunucudaki src/motor/onbellek.js'in karşılığı): geçen video 4 MB'lık bloklar
    // halinde telefonun önbellek klasöründe; aynı yer yeniden istenince TorrServer'a gitmeden veriliyor.
    // Sınır ana ekrandan elle (Onbellek.kt), en uzun süredir kullanılmayan bloklar siliniyor.
    private const val BLOK = 4 * 1024 * 1024
    private const val GB = 1024L * 1024 * 1024
    private val MIME = mapOf("mkv" to "video/x-matroska", "mp4" to "video/mp4", "m4v" to "video/mp4", "webm" to "video/webm", "avi" to "video/x-msvideo")

    private data class Dosya(val id: Int, val boy: Long, val yol: String)

    @Volatile private var surec: Process? = null
    @Volatile private var sunucu: ServerSocket? = null
    @Volatile private var onbellek: File? = null
    @Volatile private var sinirBayt = 0L
    private val yazici = Executors.newSingleThreadExecutor()
    private val secilen = ConcurrentHashMap<String, Dosya>() // "hash/sıra" -> TorrServer dosyası

    fun calisiyor() = sunucu?.isClosed == false

    fun onbellekSiniri(gb: Float) {
        sinirBayt = (gb.coerceAtLeast(0f) * GB).toLong()
        thread { runCatching { temizle() } }
    }

    // Arka plan iş parçacığında çağrılmalı (en çok ~15 sn sürer). Açıksa ya da gerek yoksa hemen döner.
    @Synchronized
    fun hazirla(ctx: Context) {
        if (sunucu?.isClosed == false) return
        if (acikMi("http://127.0.0.1:$PORT/settings")) return // telefonun kendi Stremio'su
        val exe = File(ctx.applicationInfo.nativeLibraryDir, "libtorrserver.so")
        if (!exe.exists()) return
        val ss = runCatching { ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1")) }.getOrNull() ?: return
        try {
            if (!acikMi("$TS/echo")) {
                val veri = File(ctx.filesDir, "torrserver").apply { mkdirs() }
                surec = ProcessBuilder(exe.absolutePath, "-p", "$TS_PORT", "-i", "127.0.0.1", "-d", veri.absolutePath)
                    .redirectErrorStream(true)
                    .redirectOutput(File(veri, "cikti.txt"))
                    .start()
                var n = 0
                while (!acikMi("$TS/echo") && n++ < 60) Thread.sleep(250)
                if (!acikMi("$TS/echo")) error("TorrServer açılmadı")
            }
            ayarla()
        } catch (e: Exception) {
            Log.w(ETIKET, "motor açılamadı", e)
            runCatching { ss.close() }
            surec?.destroy()
            surec = null
            return
        }
        sunucu = ss
        onbellek = File(ctx.cacheDir, "video").apply { mkdirs() }
        onbellekSiniri(Onbellek.gb(ctx))
        thread(isDaemon = true, name = "motor") {
            while (!ss.isClosed) {
                val s = runCatching { ss.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { isle(s) }.onFailure { Log.w(ETIKET, "istek", it) } }
            }
        }
        Log.i(ETIKET, "TorrServer motoru açık")
    }

    fun durdur() {
        runCatching { sunucu?.close() }
        sunucu = null
        thread { runCatching { oku("$TS/shutdown", null, 1000) } }
        surec?.destroy()
        surec = null
        secilen.clear()
    }

    // Telefona göre: bağlantı 60, RAM önbelleği 128 MB; okuyan kalmayınca torrent 30 sn sonra kapanıyor.
    private fun ayarla() {
        val simdiki = JSONObject(oku("$TS/settings", """{"action":"get"}""") ?: "{}")
        simdiki.put("ConnectionsLimit", 60).put("CacheSize", 128L * 1024 * 1024).put("ReaderReadAHead", 95)
            .put("TorrentDisconnectTimeout", 30).put("RemoveCacheOnDrop", true)
            .put("EnableDLNA", false).put("EnableBonjour", false)
        oku("$TS/settings", JSONObject().put("action", "set").put("sets", simdiki).toString())
    }

    // ---- HTTP katmanı -----------------------------------------------------------------------

    private fun isle(s: Socket) = s.use {
        val giris = it.getInputStream()
        val satir = satirOku(giris) ?: return
        val parca = satir.split(" ")
        val yontem = parca.getOrElse(0) { "GET" }
        val uri = Uri.parse("http://127.0.0.1" + parca.getOrElse(1) { "/" })
        val basliklar = HashMap<String, String>()
        while (true) {
            val l = satirOku(giris) ?: break
            if (l.isEmpty()) break
            val i = l.indexOf(':')
            if (i > 0) basliklar[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
        }
        val cikis = it.getOutputStream()
        val yol = uri.path ?: "/"
        when {
            yol == "/settings" -> json(cikis, 200, """{"options":[],"values":{"serverVersion":"torrserver"}}""")
            yol == "/stats.json" -> {
                val liste = runCatching { JSONArray(oku("$TS/torrents", """{"action":"list"}""") ?: "[]") }.getOrElse { JSONArray() }
                val sonuc = JSONObject()
                for (i in 0 until liste.length()) liste.optJSONObject(i)?.let { t -> sonuc.put(t.optString("hash"), istatistik(t)) }
                json(cikis, 200, sonuc.toString())
            }
            ISLEM.matches(yol) -> {
                val m = ISLEM.find(yol)!!
                val ih = m.groupValues[1].lowercase()
                if (m.groupValues[2] == "remove") {
                    oku("$TS/torrents", JSONObject().put("action", "drop").put("hash", ih).toString())
                    secilen.keys.removeAll { k -> k.startsWith("$ih/") }
                    json(cikis, 200, "{}")
                } else {
                    json(cikis, 200, torrent(ih)?.let { t -> istatistik(t).toString() } ?: "null")
                }
            }
            DOSYA.matches(yol) && (yontem == "GET" || yontem == "HEAD") -> {
                val m = DOSYA.find(yol)!!
                akit(cikis, yontem, m.groupValues[1].lowercase(), m.groupValues[2].toInt(), uri, basliklar["range"])
            }
            else -> json(cikis, 404, """{"error":"yok"}""")
        }
    }

    private fun akit(cikis: OutputStream, yontem: String, ih: String, idx: Int, uri: Uri, aralik: String?) {
        val tr = uri.getQueryParameters("tr").filter { it.startsWith("tracker:") }.map { it.removePrefix("tracker:") }
        val ad = uri.getQueryParameter("f")
        if (sinirBayt > 0 && onbellek != null) return onbellekliAkit(cikis, yontem, ih, idx, tr, ad, aralik)
        val id = dosya(ih, idx, tr, ad)?.id ?: return json(cikis, 504, """{"error":"metadata"}""")
        val c = URL("$TS/stream?link=$ih&index=$id&play").openConnection() as HttpURLConnection
        c.requestMethod = if (yontem == "HEAD") "HEAD" else "GET"
        c.connectTimeout = 10_000
        c.readTimeout = 120_000
        if (aralik != null) c.setRequestProperty("Range", aralik)
        try {
            val kod = c.responseCode
            val baslik = StringBuilder("HTTP/1.1 $kod ${c.responseMessage ?: ""}\r\n")
            for (b in listOf("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges")) {
                c.getHeaderField(b)?.let { baslik.append("$b: $it\r\n") }
            }
            baslik.append("Connection: close\r\n\r\n")
            cikis.write(baslik.toString().toByteArray())
            if (yontem != "HEAD") (if (kod >= 400) c.errorStream else c.inputStream)?.use { it.copyTo(cikis, 64 * 1024) }
            cikis.flush()
        } finally {
            c.disconnect()
        }
    }

    // Torrent'i (gerekirse) açar, metadata gelince dosyayı seçer. TorrServer dolgu (pad) dosyalarını
    // saymıyor, Torrentio'nun sırası sayıyor: önce adla (f=), ad yoksa sıra bir videoya denk geliyorsa
    // o, gelmiyorsa en büyük video (sunucudaki dosyaSec ile aynı kural).
    private fun dosya(ih: String, idx: Int, tr: List<String>, ad: String?): Dosya? {
        val anahtar = "$ih/$idx"
        var t = torrent(ih)
        secilen[anahtar]?.let { if (t != null) return it }
        if (t == null) {
            val magnet = "magnet:?xt=urn:btih:$ih" + tr.joinToString("") { "&tr=" + Uri.encode(it) }
            oku("$TS/torrents", JSONObject().put("action", "add").put("link", magnet).put("save_to_db", false).toString())
        }
        val son = System.currentTimeMillis() + 120_000
        while ((t?.optJSONArray("file_stats")?.length() ?: 0) == 0) {
            if (System.currentTimeMillis() > son) return null
            Thread.sleep(300)
            t = torrent(ih)
        }
        val fs = t!!.getJSONArray("file_stats")
        val dosyalar = (0 until fs.length()).map { fs.getJSONObject(it) }.sortedBy { it.optInt("id") }
        val sonAd = { f: JSONObject -> f.optString("path").substringAfterLast('/') }
        val f = ad?.let { a -> dosyalar.firstOrNull { sonAd(it) == a } }
            ?: dosyalar.getOrNull(idx)?.takeIf { idx >= 0 && VIDEO.containsMatchIn(sonAd(it)) }
            ?: (dosyalar.filter { VIDEO.containsMatchIn(sonAd(it)) }.ifEmpty { dosyalar }).maxByOrNull { it.optLong("length") }
            ?: return null
        return Dosya(f.optInt("id"), f.optLong("length"), f.optString("path")).also { secilen[anahtar] = it }
    }

    // ---- önbellek -----------------------------------------------------------------------------

    // İstenen aralığın baştaki önbellekte olan blokları diskten, kalanı TorrServer'dan; geçerken tam
    // bloklar önbelleğe yazılıyor. Dosya seçimi daha önce yapıldıysa TorrServer beklenmiyor.
    private fun onbellekliAkit(cikis: OutputStream, yontem: String, ih: String, idx: Int, tr: List<String>, ad: String?, aralik: String?) {
        val anahtar = "$idx|${ad ?: ""}"
        var f = secimOku(ih, anahtar)
        if (f != null) {
            thread { runCatching { dosya(ih, idx, tr, ad) } } // torrent arkada açılsın: önbellek bitince lazım
        } else {
            f = dosya(ih, idx, tr, ad) ?: return json(cikis, 504, """{"error":"metadata"}""")
            secimYaz(ih, anahtar, f)
        }
        val boy = f.boy
        val m = aralik?.let { Regex("^bytes=(\\d*)-(\\d*)$").find(it.trim()) }
        var bas = 0L
        var son = boy - 1
        if (m != null) {
            val (a, b) = m.destructured
            if (a.isEmpty() && b.isNotEmpty()) bas = maxOf(0L, boy - b.toLong())
            else {
                bas = a.toLongOrNull() ?: 0L
                if (b.isNotEmpty()) son = minOf(boy - 1, b.toLong())
            }
        }
        if (bas >= boy || bas > son) {
            cikis.write("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$boy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            return
        }
        val tur = MIME[f.yol.substringAfterLast('.').lowercase()] ?: "application/octet-stream"
        val baslik = StringBuilder(if (m != null) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
            .append("Content-Type: $tur\r\nAccept-Ranges: bytes\r\nContent-Length: ${son - bas + 1}\r\n")
        if (m != null) baslik.append("Content-Range: bytes $bas-$son/$boy\r\n")
        cikis.write(baslik.append("Connection: close\r\n\r\n").toString().toByteArray())
        if (yontem == "HEAD") return cikis.flush()

        var konum = bas
        while (konum <= son) {
            val no = konum / BLOK
            val veri = blokOku(ih, f.id, no, boy) ?: break
            val a = (konum - no * BLOK).toInt()
            val b = minOf(veri.size.toLong(), son - no * BLOK + 1).toInt()
            cikis.write(veri, a, b - a)
            konum = no * BLOK + b
        }
        if (konum > son) return cikis.flush()

        val c = URL("$TS/stream?link=$ih&index=${f.id}&play").openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        c.readTimeout = 120_000
        c.setRequestProperty("Range", "bytes=$konum-$son")
        try {
            if (c.responseCode != 206 && c.responseCode != 200) return
            c.inputStream.use { giris ->
                val tampon = ByteArray(64 * 1024)
                var pos = konum
                var blokNo = (konum + BLOK - 1) / BLOK // ilk tam blok (baştaki yarım blok yazılmaz)
                var toplanan = java.io.ByteArrayOutputStream(BLOK)
                while (true) {
                    val n = giris.read(tampon)
                    if (n < 0) break
                    cikis.write(tampon, 0, n)
                    var off = 0
                    while (off < n) {
                        val blokBas = blokNo * BLOK
                        if (pos + off < blokBas) {
                            off = minOf(n.toLong(), blokBas - pos).toInt()
                            continue
                        }
                        val blokSon = blokBas + minOf(BLOK.toLong(), boy - blokBas)
                        val al = minOf((n - off).toLong(), blokSon - (pos + off)).toInt()
                        toplanan.write(tampon, off, al)
                        off += al
                        if (blokBas + toplanan.size() == blokSon) {
                            blokYaz(ih, f.id, blokNo, toplanan.toByteArray())
                            toplanan = java.io.ByteArrayOutputStream(BLOK)
                            blokNo++
                        }
                    }
                    pos += n
                }
            }
            cikis.flush()
        } finally {
            c.disconnect()
        }
    }

    private fun blokDosyasi(ih: String, id: Int, no: Long) = File(onbellek, "$ih/$id/$no.blk")

    private fun blokOku(ih: String, id: Int, no: Long, boy: Long): ByteArray? = runCatching {
        val d = blokDosyasi(ih, id, no)
        if (!d.exists()) return null
        val veri = d.readBytes()
        if (veri.size.toLong() != minOf(BLOK.toLong(), boy - no * BLOK)) return null
        d.setLastModified(System.currentTimeMillis()) // temizlikte en son silinsin
        veri
    }.getOrNull()

    // Ayrı iş parçacığında, geçici dosyaya yazıp yeniden adlandırarak (yarım blok "var" görünmesin).
    private fun blokYaz(ih: String, id: Int, no: Long, veri: ByteArray) {
        if (sinirBayt <= 0) return
        yazici.execute {
            runCatching {
                val d = blokDosyasi(ih, id, no)
                d.parentFile?.mkdirs()
                val gecici = File(d.path + ".yaziliyor")
                gecici.writeBytes(veri)
                gecici.renameTo(d)
                if (++yazilan % 16 == 0) temizle()
            }
        }
    }
    @Volatile private var yazilan = 0

    private fun secimOku(ih: String, anahtar: String): Dosya? = runCatching {
        val j = JSONObject(File(onbellek, "$ih/secim.json").readText()).optJSONObject(anahtar) ?: return null
        Dosya(j.getInt("id"), j.getLong("boy"), j.optString("yol"))
    }.getOrNull()

    private fun secimYaz(ih: String, anahtar: String, f: Dosya) {
        runCatching {
            val d = File(onbellek, "$ih/secim.json")
            d.parentFile?.mkdirs()
            val j = runCatching { JSONObject(d.readText()) }.getOrDefault(JSONObject())
            j.put(anahtar, JSONObject().put("id", f.id).put("boy", f.boy).put("yol", f.yol))
            d.writeText(j.toString())
        }
    }

    // Sınırı aşınca en uzun süredir kullanılmayan bloklar silinir (sınır 0: hepsi).
    @Synchronized
    private fun temizle() {
        val kok = onbellek ?: return
        val bloklar = kok.walkTopDown().filter { it.isFile && it.name.endsWith(".blk") }.toMutableList()
        var toplam = bloklar.sumOf { it.length() }
        if (toplam <= sinirBayt) return
        bloklar.sortBy { it.lastModified() }
        for (b in bloklar) {
            if (toplam <= sinirBayt * 9 / 10) break
            val boy = b.length()
            if (b.delete()) toplam -= boy
        }
    }

    private fun torrent(ih: String): JSONObject? = runCatching {
        JSONObject(oku("$TS/torrents", JSONObject().put("action", "get").put("hash", ih).toString()) ?: return null)
            .takeIf { it.optString("hash").isNotEmpty() }
    }.getOrNull()

    // TorrServer durumu -> Stremio'nun stats.json biçimi (sayfanın okuduğu alanlar).
    private fun istatistik(t: JSONObject) = JSONObject()
        .put("infoHash", t.optString("hash"))
        .put("peers", t.optInt("active_peers"))
        .put("swarmSize", t.optInt("total_peers"))
        .put("downloadSpeed", t.optDouble("download_speed", 0.0))
        .put("uploaded", t.optLong("bytes_written_data"))
        .put("selections", JSONArray())

    // ---- yardımcılar ------------------------------------------------------------------------

    private fun json(cikis: OutputStream, kod: Int, govde: String) {
        val b = govde.toByteArray()
        cikis.write("HTTP/1.1 $kod OK\r\nContent-Type: application/json\r\nContent-Length: ${b.size}\r\nConnection: close\r\n\r\n".toByteArray())
        cikis.write(b)
        cikis.flush()
    }

    private fun satirOku(giris: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = giris.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            sb.append(c.toChar())
            if (sb.length > 16_384) return null
        }
    }

    // POST (govde varsa) ya da GET; cevap metni ya da null.
    private fun oku(adres: String, govde: String?, zaman: Int = 15_000): String? = runCatching {
        val c = URL(adres).openConnection() as HttpURLConnection
        c.connectTimeout = zaman
        c.readTimeout = zaman
        if (govde != null) {
            c.requestMethod = "POST"
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(govde.toByteArray()) }
        }
        try {
            if (c.responseCode >= 400) null else c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }.getOrNull()

    private fun acikMi(adres: String) = runCatching {
        val c = URL(adres).openConnection() as HttpURLConnection
        c.connectTimeout = 1500
        c.readTimeout = 1500
        try { c.responseCode in 200..299 } finally { c.disconnect() }
    }.getOrDefault(false)
}
