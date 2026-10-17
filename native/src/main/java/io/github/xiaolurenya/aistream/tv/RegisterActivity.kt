package io.github.xiaolurenya.aistream.tv

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 站点开了注册时，可以在这里自助建号；后台开了「必须邀请码」就需要填邀请码
class RegisterActivity : AppCompatActivity() {

    private lateinit var etUser: EditText
    private lateinit var etPass: EditText
    private lateinit var etInvite: EditText
    private lateinit var tvErr: TextView
    private lateinit var btnGo: TextView
    private lateinit var pb: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_register)

        etUser = findViewById(R.id.etUser)
        etPass = findViewById(R.id.etPass)
        etInvite = findViewById(R.id.etInvite)
        tvErr = findViewById(R.id.tvErr)
        btnGo = findViewById(R.id.btnGo)
        pb = findViewById(R.id.pb)

        btnGo.setOnClickListener { submit() }
        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
    }

    private fun busy(on: Boolean) {
        pb.visibility = if (on) View.VISIBLE else View.GONE
        btnGo.isEnabled = !on
        btnGo.alpha = if (on) 0.5f else 1f
    }

    private fun showErr(s: String?) {
        if (s.isNullOrBlank()) tvErr.visibility = View.GONE
        else { tvErr.text = s; tvErr.visibility = View.VISIBLE }
    }

    private fun submit() {
        showErr(null)
        val u = etUser.text.toString().trim()
        val p = etPass.text.toString()
        val inv = etInvite.text.toString().trim()
        if (u.length < 2) { showErr("用户名至少 2 位"); return }
        if (p.length < 6) { showErr("密码至少 6 位"); return }

        busy(true)
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { Api.register(u, p, inv) }
            }
            busy(false)
            r.onSuccess { resp ->
                Prefs.user = u
                Prefs.pass = p
                Prefs.token = resp.token.orEmpty()
                startActivity(Intent(this@RegisterActivity, MainActivity::class.java))
                finish()
            }.onFailure {
                showErr(it.message ?: "注册失败")
            }
        }
    }
}
