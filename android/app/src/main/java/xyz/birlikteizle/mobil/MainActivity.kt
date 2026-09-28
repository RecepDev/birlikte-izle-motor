package xyz.birlikteizle.mobil

import android.content.Intent
import android.graphics.BitmapFactory
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import org.json.JSONArray
import java.net.URL
import kotlin.concurrent.thread

// Giriş ekranı: yalnızca misafir girişi. Oda linkini yapıştır ya da arkadaşının
// gönderdiği linke dokun (uygulama o linkle doğrudan açılır).
class MainActivity : AppCompatActivity() {

    private val kayit by lazy { getSharedPreferences("ayar", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        linktenAc(intent)?.let { return odayaGit(it) }
        ekraniKur()
        // İlk açılışta ad (odalarda bu adla girilir, bir daha sorulmaz), sonra kalite.
        if (kayit.getString("isim", null).isNullOrBlank()) isimSor(ilk = true)
        else if (kayit.getString("kalite", null) == null) kaliteSor()
        // Açılışta da güncellemeye bak (odaya girince de ayrıca bakılıyor).
        thread { Guncelleme.apkDenetle(this, sunucuBul()) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        linktenAc(intent)?.let { odayaGit(it) }
    }

    // https://…trycloudflare.com/room/ABC ya da birlikteizle://<oda adresi>
    private fun linktenAc(intent: Intent?): String? {
        val veri = intent?.data ?: return null
        if (veri.scheme == "birlikteizle") {
            val kalan = veri.toString().removePrefix("birlikteizle://").trimEnd('/')
            return Uri.decode(kalan).takeIf { it.startsWith("http") }
        }
        return veri.toString()
    }

    private fun odayaGit(url: String) {
        kayit.edit().putString("sonLink", url).apply()
        startActivity(Intent(this, OdaActivity::class.java).putExtra(OdaActivity.URL, url))
    }

    // Odadan geri dönünce liste tazelensin.
    private var odalarKutusu: LinearLayout? = null
    // Açılış ekranı açıkken liste 5 sn'de bir tazelenir: kapanan oda kaybolur, yeni oda gelir.
    private val tazele = android.os.Handler(android.os.Looper.getMainLooper())
    private val tazeleIs = object : Runnable {
        override fun run() {
            odalarKutusu?.let { odalariGetir(it) }
            tazele.postDelayed(this, 5000)
        }
    }

    override fun onResume() {
        super.onResume()
        tazele.post(tazeleIs)
    }

    override fun onPause() {
        tazele.removeCallbacks(tazeleIs)
        super.onPause()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // Son girilen odanın sunucusundaki açık odalar. Tünel adresi değiştiyse (host sunucuyu
    // yeniden başlattıysa) liste gelmez, yeni linki yapıştırmak gerekir.
    // Host'un sunucusu: önce ntfy.sh'deki güncel adres (tünel adresi değişmiş olabilir),
    // yoksa son girilen odanınki. Ağ kullandığı için arka planda çağrılmalı.
    // ntfy'ye 5 sn'de bir sormamak için bulunan adres bir dakika saklanıyor.
    @Volatile private var bulunan: Pair<String, Long>? = null

    private fun sunucuBul(): String? {
        bulunan?.takeIf { System.currentTimeMillis() - it.second < 60_000 }?.let { return it.first }
        // Konu adı uygulamaya gömülü (host'un sunucusundan, paketlenirken): link hiç gerekmesin.
        val konu = kayit.getString("konu", null)
            ?: runCatching { assets.open("kesif.txt").bufferedReader().use { it.readText().trim() } }.getOrNull()
        Guncelleme.ntfyAdresi(konu)?.let {
            bulunan = it to System.currentTimeMillis()
            return it
        }
        val son = kayit.getString("sonLink", null)?.let { Uri.parse(it) } ?: return null
        return if (son.scheme?.startsWith("http") == true) "${son.scheme}://${son.authority}" else null
    }

    private fun odalariGetir(kutu: LinearLayout) {
        thread {
            val sunucu = sunucuBul() ?: return@thread
            val liste = Guncelleme.oku("$sunucu/odalar.json", 4000)?.let { runCatching { JSONArray(it) }.getOrNull() }
            runOnUiThread {
                when {
                    // Host sunucuyu yeniden başlatınca tünel adresi değişiyor: eski adres cevap vermez.
                    liste == null -> odaNotu(kutu, "Son girdiğin sunucuya ulaşılamadı. Adres değişmiş olabilir: arkadaşından yeni oda linkini iste, bir kez gir, liste yine gelir.")
                    liste.length() == 0 -> odaNotu(kutu, "Şu an açık oda yok.")
                    else -> odalariCiz(kutu, sunucu, liste)
                }
            }
        }
    }

    private fun odaNotu(kutu: LinearLayout, metin: String) {
        kutu.removeAllViews()
        kutu.addView(TextView(this).apply {
            text = metin
            textSize = 13f
            setTextColor(ContextCompat.getColor(context, R.color.soluk))
            setPadding(0, 0, 0, dp(12))
        })
        kutu.visibility = android.view.View.VISIBLE
    }

    private fun odalariCiz(kutu: LinearLayout, sunucu: String, liste: JSONArray) {
        val yazi = ContextCompat.getColor(this, R.color.yazi)
        val soluk = ContextCompat.getColor(this, R.color.soluk)
        kutu.removeAllViews()
        kutu.addView(TextView(this).apply {
            text = "Açık odalar"
            textSize = 15f
            setTextColor(yazi)
            setPadding(0, 0, 0, dp(8))
        })
        for (i in 0 until liste.length()) {
            val oda = liste.getJSONObject(i)
            val satir = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(8), dp(8), dp(8), dp(8))
                background = GradientDrawable().apply {
                    cornerRadius = dp(10).toFloat()
                    setColor(ContextCompat.getColor(context, R.color.zemin))
                }
                setOnClickListener { odayaGit("$sunucu/room/${oda.getString("id")}") }
            }
            val afis = ImageView(this).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                setBackgroundColor(0xFF232633.toInt())
            }
            satir.addView(afis, LinearLayout.LayoutParams(dp(36), dp(54)))
            oda.optString("poster").takeIf { it.startsWith("http") }?.let { adres ->
                thread {
                    val resim = runCatching { URL(adres).openStream().use { BitmapFactory.decodeStream(it) } }.getOrNull()
                    if (resim != null) runOnUiThread { afis.setImageBitmap(resim) }
                }
            }
            val metinler = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(12), 0, 0, 0)
            }
            metinler.addView(TextView(this).apply {
                text = oda.optString("name")
                textSize = 15f
                setTextColor(yazi)
            })
            metinler.addView(TextView(this).apply {
                text = "${oda.optInt("users")} kişi · ${if (oda.optBoolean("playing")) "▶ oynuyor" else "⏸ duraklatıldı"}"
                textSize = 12f
                setTextColor(soluk)
            })
            satir.addView(metinler)
            kutu.addView(satir, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(8)
            })
        }
        kutu.visibility = android.view.View.VISIBLE
    }

    private fun ekraniKur() {
        val yazi = ContextCompat.getColor(this, R.color.yazi)
        val soluk = ContextCompat.getColor(this, R.color.soluk)
        val kart = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(24))
            background = GradientDrawable().apply {
                cornerRadius = dp(16).toFloat()
                setColor(ContextCompat.getColor(context, R.color.kart))
            }
        }
        kart.addView(TextView(this).apply {
            text = "Birlikte İzle"
            textSize = 22f
            setTextColor(yazi)
        })
        kart.addView(TextView(this).apply {
            text = "Arkadaşının gönderdiği oda linkini yapıştır. Linke dokunarak da açabilirsin."
            textSize = 14f
            setTextColor(soluk)
            setPadding(0, dp(8), 0, dp(16))
        })
        val odalar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = android.view.View.GONE
        }
        kart.addView(odalar)
        odalarKutusu = odalar
        val link = EditText(this).apply {
            hint = "https://… /room/ABC123"
            setText(kayit.getString("sonLink", ""))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            setTextColor(yazi)
            setHintTextColor(soluk)
        }
        kart.addView(link)
        val gir = Button(this).apply {
            text = "Odaya gir"
            setTextColor(0xFFFFFFFF.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(ContextCompat.getColor(context, R.color.vurgu))
            }
        }
        val git = {
            val url = link.text.toString().trim()
            if (!url.startsWith("http")) {
                Toast.makeText(this, "Linkin başı http ile başlamalı.", Toast.LENGTH_SHORT).show()
            } else {
                odayaGit(url)
            }
        }
        gir.setOnClickListener { git() }
        link.setOnEditorActionListener { _, _, _ -> git(); true }
        kart.addView(gir, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(48)).apply {
            topMargin = dp(16)
        })
        val guncelle = Button(this).apply {
            text = "Güncellemeleri denetle"
            setTextColor(yazi)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF232633.toInt())
            }
            setOnClickListener {
                Toast.makeText(this@MainActivity, "Denetleniyor…", Toast.LENGTH_SHORT).show()
                thread { Guncelleme.apkDenetle(this@MainActivity, sunucuBul(), elle = true) }
            }
        }
        kart.addView(guncelle, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply {
            topMargin = dp(10)
        })
        isimDugmesi = Button(this).apply {
            text = isimYazisi()
            setTextColor(yazi)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF232633.toInt())
            }
            setOnClickListener { isimSor(ilk = false) }
        }
        kart.addView(isimDugmesi, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply {
            topMargin = dp(10)
        })
        kaliteDugmesi = Button(this).apply {
            text = kaliteYazisi()
            setTextColor(yazi)
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF232633.toInt())
            }
            setOnClickListener { kaliteSor() }
        }
        kart.addView(kaliteDugmesi, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(44)).apply {
            topMargin = dp(10)
        })
        // Hangi sürümün kurulu olduğu görünsün (güncelleme geldi mi diye bakmak için).
        kart.addView(TextView(this).apply {
            text = "Sürüm ${packageManager.getPackageInfo(packageName, 0).versionName}"
            textSize = 12f
            setTextColor(soluk)
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, 0)
        })

        val kok = LinearLayout(this).apply {
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(20), dp(20), dp(20))
            addView(kart, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        setContentView(kok)
    }

    // ---- ad ------------------------------------------------------------------------------
    private var isimDugmesi: Button? = null
    private fun isimYazisi() = "Adın: ${kayit.getString("isim", null)?.takeIf { it.isNotBlank() } ?: "girilmedi"}"
    private fun isimSor(ilk: Boolean) {
        val kutu = EditText(this).apply {
            setText(kayit.getString("isim", "") ?: "")
            hint = "Adın"
            setSingleLine()
        }
        val pencere = android.app.AlertDialog.Builder(this)
            .setTitle("Adın ne?")
            .setMessage("Odalarda bu adla görünürsün.")
            .setView(kutu)
            .setCancelable(!ilk)
            .setPositiveButton("Kaydet", null)
            .create()
        pencere.setOnShowListener {
            pencere.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val ad = kutu.text.toString().trim().take(30)
                if (ad.isEmpty()) return@setOnClickListener
                kayit.edit().putString("isim", ad).apply()
                isimDugmesi?.text = isimYazisi()
                pencere.dismiss()
                if (ilk && kayit.getString("kalite", null) == null) kaliteSor()
            }
        }
        pencere.show()
    }

    // ---- tercih edilen görüntü kalitesi -------------------------------------------------
    // Odada kalite listesinde bu kalite en üstte olur, önce onun kaynakları aranır.
    private var kaliteDugmesi: Button? = null
    private val kaliteler = arrayOf("2160p", "1080p", "720p")
    private val kaliteAdlari = arrayOf("4K (2160p)", "1080p", "720p")
    private fun kaliteYazisi(): String {
        val k = kayit.getString("kalite", null)
        val ad = kaliteler.indexOf(k).takeIf { it >= 0 }?.let { kaliteAdlari[it] } ?: "seçilmedi"
        return "Görüntü kalitesi: $ad"
    }
    private fun kaliteSor() {
        android.app.AlertDialog.Builder(this)
            .setTitle("Hangi görüntü kalitesini tercih edersin?")
            .setItems(kaliteAdlari) { _, i ->
                kayit.edit().putString("kalite", kaliteler[i]).apply()
                kaliteDugmesi?.text = kaliteYazisi()
            }
            .show()
    }
}
