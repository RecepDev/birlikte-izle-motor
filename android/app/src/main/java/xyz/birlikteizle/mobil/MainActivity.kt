package xyz.birlikteizle.mobil

import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

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

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

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

        val kok = LinearLayout(this).apply {
            gravity = Gravity.CENTER
            setPadding(dp(20), dp(20), dp(20), dp(20))
            addView(kart, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        setContentView(kok)
    }
}
