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
            val kalan = veri.toString().removePrefix("birlikteizlemotor://").trimEnd('/')
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
            // Kart: üstte afiş + ad + durum; yayın açıksa altında tam genişlik "Yayına gir"
            // (yan yana sığmıyordu, ad iki satıra bölünüp sıkışıyordu).
            val kartOda = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(10), dp(10), dp(10))
                background = GradientDrawable().apply {
                    cornerRadius = dp(12).toFloat()
                    setColor(ContextCompat.getColor(context, R.color.zemin))
                }
                setOnClickListener { odayaGit("$sunucu/room/${oda.getString("id")}") }
            }
            val satir = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }
            kartOda.addView(satir)
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
                text = "${if (oda.optBoolean("yayin")) "📡 Canlı yayın · " else ""}${oda.optInt("users")} kişi · ${if (oda.optBoolean("playing")) "▶ oynuyor" else "⏸ duraklatıldı"}"
                textSize = 12f
                setTextColor(soluk)
            })
            satir.addView(metinler, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            // Yayın açıksa doğrudan yayına giriş (odaya girince kendi kaynağı açılmadan yayın başlar).
            if (oda.optBoolean("yayin")) {
                kartOda.addView(Button(this).apply {
                    text = "📡 Yayına gir"
                    isAllCaps = false
                    setTextColor(0xFFFFFFFF.toInt())
                    textSize = 14f
                    background = GradientDrawable().apply {
                        cornerRadius = dp(10).toFloat()
                        setColor(ContextCompat.getColor(context, R.color.vurgu))
                    }
                    setOnClickListener { odayaGit("$sunucu/room/${oda.getString("id")}") }
                }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)).apply { topMargin = dp(10) })
            }
            kutu.addView(kartOda, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
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
        // Başlık ve sağ üstte "⋮" menüsü (Link ile odaya gir).
        val baslik = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        baslik.addView(TextView(this).apply {
            text = "Birlikte İzle"
            textSize = 22f
            setTextColor(yazi)
        }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val menuDugmesi = TextView(this).apply {
            text = "⋮"
            textSize = 24f
            setTextColor(yazi)
            gravity = Gravity.CENTER
            contentDescription = "Menü"
            isClickable = true
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(0xFF232633.toInt())
            }
        }
        menuDugmesi.setOnClickListener { v ->
            android.widget.PopupMenu(this, v).apply {
                menu.add(0, 1, 0, "🔗 Link ile odaya gir")
                setOnMenuItemClickListener { if (it.itemId == 1) linkIleGir(); true }
                show()
            }
        }
        baslik.addView(menuDugmesi, LinearLayout.LayoutParams(dp(44), dp(44)))
        kart.addView(baslik)
        kart.addView(TextView(this).apply {
            text = "Açık odalardan birine dokun. Arkadaşının gönderdiği linke dokunarak ya da sağ üstteki ⋮ menüsünden de girebilirsin."
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
        val guncelle = Button(this).apply {
            text = "Güncellemeleri denetle"
            isAllCaps = false
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
        // Ayarlar: tek kutuda satırlar (masaüstü açılış ekranı gibi).
        val ayarlar = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = dp(12).toFloat()
                setStroke(dp(1), 0xFF2A2E39.toInt())
            }
        }
        fun satir(baslik: String, aciklama: String, sag: android.view.View, tik: (() -> Unit)?): LinearLayout {
            val metin = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(context).apply { text = baslik; textSize = 15f; setTextColor(yazi) })
                addView(TextView(context).apply { text = aciklama; textSize = 12f; setTextColor(soluk) })
            }
            return LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                addView(metin, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                addView(sag)
                if (tik != null) {
                    isClickable = true
                    setOnClickListener { tik() }
                }
            }
        }
        fun ayrac() = android.view.View(this).apply { setBackgroundColor(0xFF2A2E39.toInt()) }
        val degerYazisi = { TextView(this).apply { textSize = 14f; setTextColor(ContextCompat.getColor(context, R.color.vurgu)) } }

        isimDugmesi = degerYazisi().apply { text = isimYazisi() }
        ayarlar.addView(satir("👤 Adın", "Odalarda bu adla görünürsün", isimDugmesi!!) { isimSor(ilk = false) })
        ayarlar.addView(ayrac(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))
        val otoAnahtar = android.widget.Switch(this).apply {
            isChecked = kayit.getBoolean("oto", true)
            setOnCheckedChangeListener { _, acik -> kayit.edit().putBoolean("oto", acik).apply() }
        }
        ayarlar.addView(satir("🤖 Otomatik kaynak", "Seçtiğin kaliteye en uygun kaynağı test edip açar", otoAnahtar) { otoAnahtar.toggle() })
        ayarlar.addView(ayrac(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))
        kaliteDugmesi = degerYazisi().apply { text = kaliteYazisi() }
        ayarlar.addView(satir("Görüntü kalitesi", "Önce bu kalitenin kaynakları aranır", kaliteDugmesi!!) { kaliteSor() })
        ayarlar.addView(ayrac(), LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)))
        onbellekDugmesi = degerYazisi().apply { text = Onbellek.yazi(Onbellek.gb(this@MainActivity)) }
        ayarlar.addView(satir("💾 Önbellek", "İzlenen yerler telefonda kalır, yeniden açınca hemen gelir", onbellekDugmesi!!) { onbellekSor() })
        kart.addView(ayarlar, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(16)
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

    // ---- otomatik kaynak: odada seçilen kaliteye en uygun kaynak açılır ------------------

    // ---- link ile odaya giriş (⋮ menüsü) -----------------------------------------------
    private fun linkIleGir() {
        val kutu = EditText(this).apply {
            hint = "https://… /room/ABC123"
            setText(kayit.getString("sonLink", ""))
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
            selectAll()
        }
        val pencere = android.app.AlertDialog.Builder(this)
            .setTitle("Link ile odaya gir")
            .setMessage("Arkadaşının gönderdiği oda linkini yapıştır.")
            .setView(kutu)
            .setNegativeButton("Vazgeç", null)
            .setPositiveButton("Odaya gir", null)
            .create()
        val git = {
            val url = kutu.text.toString().trim()
            if (!url.startsWith("http")) {
                Toast.makeText(this, "Linkin başı http ile başlamalı.", Toast.LENGTH_SHORT).show()
            } else {
                pencere.dismiss()
                odayaGit(url)
            }
        }
        pencere.setOnShowListener {
            pencere.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener { git() }
        }
        kutu.setOnEditorActionListener { _, _, _ -> git(); true }
        pencere.show()
    }

    // ---- ad ------------------------------------------------------------------------------
    private var isimDugmesi: TextView? = null
    private fun isimYazisi() = kayit.getString("isim", null)?.takeIf { it.isNotBlank() } ?: "girilmedi"
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

    // ---- video önbelleği boyutu (elle, GB; 0 = kapalı) ----------------------------------
    private var onbellekDugmesi: TextView? = null
    private fun onbellekSor() {
        val kutu = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL
            setText(Onbellek.gb(this@MainActivity).let { if (it % 1f == 0f) it.toInt().toString() else it.toString() })
            selectAll()
        }
        val pencere = android.app.AlertDialog.Builder(this)
            .setTitle("Önbellek (GB)")
            .setMessage("Telefonda izlenen yerler için ayrılacak yer. Dolunca en eski kullanılan silinir. 0 = kapalı.")
            .setView(kutu)
            .setNegativeButton("Vazgeç", null)
            .setPositiveButton("Kaydet", null)
            .create()
        pencere.setOnShowListener {
            pencere.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val gb = kutu.text.toString().replace(',', '.').toFloatOrNull()
                if (gb == null || gb < 0f || gb > 1000f) {
                    Toast.makeText(this, "0 ile 1000 arasında bir sayı gir.", Toast.LENGTH_SHORT).show()
                } else {
                    Onbellek.kaydet(this, gb)
                    onbellekDugmesi?.text = Onbellek.yazi(gb)
                    thread { Onbellek.uygula(applicationContext) }
                    pencere.dismiss()
                }
            }
        }
        pencere.show()
    }

    // ---- tercih edilen görüntü kalitesi -------------------------------------------------
    // Odada kalite listesinde bu kalite en üstte olur, önce onun kaynakları aranır.
    private var kaliteDugmesi: TextView? = null
    private val kaliteler = arrayOf("2160p", "1080p", "720p")
    private val kaliteAdlari = arrayOf("4K (2160p)", "1080p", "720p")
    private fun kaliteYazisi(): String {
        val k = kayit.getString("kalite", null)
        val ad = kaliteler.indexOf(k).takeIf { it >= 0 }?.let { kaliteAdlari[it] } ?: "seçilmedi"
        return ad
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
