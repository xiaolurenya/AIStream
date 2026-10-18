package io.github.xiaolurenya.aistream.tv

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.addTextChangedListener
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 第一屏：填自己的站点地址 + 账号密码，登录成功把凭证存本机，之后自动进首页
class SetupActivity : AppCompatActivity() {

    private lateinit var chipHttp: TextView
    private lateinit var chipHttps: TextView
    private lateinit var etHost: EditText
    private lateinit var etPort: EditText
    private lateinit var etUser: EditText
    private lateinit var etPass: EditText
    private lateinit var tvErr: TextView
    private lateinit var btnGo: TextView
    private lateinit var pb: ProgressBar
    private lateinit var tvClear: TextView

    private var proto = "http"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        chipHttp = findViewById(R.id.chipHttp)
        chipHttps = findViewById(R.id.chipHttps)
        etHost = findViewById(R.id.etHost)
        etPort = findViewById(R.id.etPort)
        etUser = findViewById(R.id.etUser)
        etPass = findViewById(R.id.etPass)
        tvErr = findViewById(R.id.tvErr)
        btnGo = findViewById(R.id.btnGo)
        pb = findViewById(R.id.pb)
        tvClear = findViewById(R.id.tvClear)

        findViewById<TextView>(R.id.tvVer).text = "原生客户端 v" + BuildConfig.VERSION_NAME

        chipHttp.setOnClickListener { setProto("http") }
        chipHttps.setOnClickListener { setProto("https") }
        btnGo.setOnClickListener { submit() }
        // 注册要打站点接口，得先有地址才能去（没配过就先让用户连上再注册）
        findViewById<TextView>(R.id.btnReg).setOnClickListener {
            if (Prefs.base.isBlank()) {
                // 注册接口要打站点，先把地址存下来（这一步不要求账号密码）
                try {
                    val base = parseTarget()
                    Prefs.proto = proto
                    Prefs.port = etPort.text.toString().trim()
                    Prefs.host = hostOnly()
                    Prefs.base = base
                } catch (e: Exception) {
                    showErr(e.message)
                    return@setOnClickListener
                }
            }
            startActivity(Intent(this, RegisterActivity::class.java))
        }
        tvClear.setOnClickListener {
            Prefs.clear()
            etPass.setText("")
            tvClear.visibility = View.GONE
            showErr("已清除，重新填一次吧")
        }

        etHost.addTextChangedListener { detectProto() }

        /* 上次崩过就先把堆栈摆出来，并停在配置页——否则一自动跳转又崩，
           陷入「打开就闪退」的死循环，大哥啥也看不到 */
        val hadCrash = Crash.showIfAny(this)

        if (Prefs.configured) {
            setProto(Prefs.proto)
            etHost.setText(Prefs.host)
            etPort.setText(Prefs.port)
            etUser.setText(Prefs.user)
            etPass.setText(Prefs.pass)
            tvClear.visibility = View.VISIBLE
            if (hadCrash) {
                Crash.reset(this)
                showErr("上次启动就崩了，已停在配置页。点「进入」重试，或复制上面的报错发我")
                return
            }
            // 凭证还在有效期就别让用户再输一遍密码
            verifyAndEnter()
        }
    }

    private fun setProto(p: String) {
        proto = p
        val on = p == "https"
        chipHttps.setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
        chipHttps.setTextColor(getColor(if (on) R.color.accent_soft else R.color.fg_dim))
        chipHttp.setBackgroundResource(if (on) R.drawable.bg_chip else R.drawable.bg_chip_on)
        chipHttp.setTextColor(getColor(if (on) R.color.fg_dim else R.color.accent_soft))
    }

    // 直接粘整条地址进来也能认：自动挑协议、剥前缀、拆端口
    private fun detectProto() {
        val raw = etHost.text.toString().trim().lowercase()
        if (raw.startsWith("https://")) setProto("https")
        else if (raw.startsWith("http://")) setProto("http")
    }

    private fun parseTarget(): String {
        var h = etHost.text.toString().trim()
        h = h.replace(Regex("(?i)^https?://"), "").trim().trimEnd('/')
        var p = etPort.text.toString().trim()
        val m = Regex("^(.+?):(\\d+)$").find(h)
        if (m != null) {
            if (p.isBlank()) p = m.groupValues[2]
            h = m.groupValues[1]
        }
        if (p.isBlank()) p = "8890"
        if (h.isBlank()) throw Api.Err("先填域名或 IP")
        etPort.setText(p)
        return "$proto://$h:$p"
    }

    private fun hostOnly(): String {
        val h = etHost.text.toString().trim()
            .replace(Regex("(?i)^https?://"), "").trim().trimEnd('/')
        return Regex("^(.+?):(\\d+)$").find(h)?.groupValues?.get(1) ?: h
    }

    private fun showErr(s: String?) {
        if (s.isNullOrBlank()) {
            tvErr.visibility = View.GONE
        } else {
            tvErr.text = s
            tvErr.visibility = View.VISIBLE
        }
    }

    private fun busy(on: Boolean) {
        pb.visibility = if (on) View.VISIBLE else View.GONE
        btnGo.isEnabled = !on
        btnGo.alpha = if (on) 0.5f else 1f
    }

    private fun submit() {
        showErr(null)
        val base: String
        val user: String
        val pass: String
        try {
            base = parseTarget()
            user = etUser.text.toString().trim()
            pass = etPass.text.toString()
            if (user.isBlank()) throw Api.Err("用户名没填")
            if (pass.isBlank()) throw Api.Err("密码没填")
        } catch (e: Exception) {
            showErr(e.message)
            return
        }

        busy(true)
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { Api.login(base, user, pass) }
            }
            busy(false)
            r.onSuccess { resp ->
                Prefs.proto = proto
                Prefs.host = hostOnly()
                Prefs.port = etPort.text.toString().trim()
                Prefs.user = user
                Prefs.pass = pass
                Prefs.base = base
                Prefs.token = resp.token.orEmpty()
                Prefs.siteName = Api.publicInfo(base)?.siteName.orEmpty()
                enterMain()
            }.onFailure { e ->
                val raw = e.message ?: "连接失败"
                val msg = if (raw.contains("SSL", true) || raw.contains("certificate", true) ||
                    raw.contains("handshake", true)
                ) {
                    "https 证书校验失败（自签名证书常见）。改用 http 试试，或换 https 端口"
                } else if (e is java.net.UnknownHostException || raw.contains("Unable to resolve", true)) {
                    "找不到这台主机，检查地址拼写 / 手机是否连着同一个网络"
                } else if (e is java.net.SocketTimeoutException || e is java.net.ConnectException) {
                    "连不上这个地址和端口。确认站点在跑、端口对、手机和服务器能互通"
                } else raw
                showErr(msg)
            }
        }
    }

    // 已存过凭证：静默验一次，有效就直接进，别每次开 APP 都让登录
    private fun verifyAndEnter() {
        busy(true)
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val s = Api.getRaw("/api/auth/me")
                    s.contains("username") || s.contains("role")
                }.getOrDefault(false)
            }
            busy(false)
            if (ok) enterMain() else showErr("登录状态已过期，重新登录一次")
        }
    }

    private fun enterMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
