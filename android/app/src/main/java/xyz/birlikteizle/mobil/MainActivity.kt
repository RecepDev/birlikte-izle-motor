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
        // Açılışta da güncellemeye bak: son girilen odanın sunucusuna soruyoruz
        // (odaya girince de ayrıca bakılıyor).
        kayit.getString("sonLink", null)?.let { Uri.parse(it) }?.takeIf { it.scheme?.startsWith("http") == true }?.let {
            Guncelleme.apkDenetle(this, "${it.scheme}://${it.authority}")
        }
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
    override fun onResume() {
        super.onResume()
        odalarKutusu?.let { odalariGetir(it) }
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    // Son girilen odanın sunucusundaki açık odalar. Tünel adresi değiştiyse (host sunucuyu
    // yeniden başlattıysa) liste gelmez, yeni linki yapıştırmak gerekir.
    private fun odalariGetir(kutu: LinearLayout) {
        val son = kayit.getString("sonLink", null)?.let { Uri.parse(it) } ?: return
        if (son.scheme?.startsWith("http") != true) return
        val sunucu = "${son.scheme}://${son.authority}"
        thread {
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
}
