package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.doOnLayout
import androidx.core.widget.addTextChangedListener
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 第一屏：填站点地址 + 账号密码，登录成功把凭证存本机，之后自动进首页
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

        findViewById<TextView>(R.id.tvVer).text = "v" + BuildConfig.VERSION_NAME

        // 焦点反馈：放大 + 提示音；描边环一个都不画（v1.4.26 重设计）——
        // 这台设备上白描边环画在聚焦控件上必退化成两根横线（三版实测），
        // 全页焦点指示 = drawable 的聚焦态亮底/色条（实心块），bindFocus 只管放大
        listOf(chipHttp, chipHttps, btnGo, tvClear, etHost, etPort, etUser, etPass).forEach { bindFocus(it, ring = false) }

        chipHttp.setOnClickListener { setProto("http") }
        chipHttps.setOnClickListener { setProto("https") }
        btnGo.setOnClickListener { submit() }
        tvClear.setOnClickListener {
            Prefs.clear()
            etPass.setText("")
            tvClear.visibility = View.GONE
            showErr("已清除，重新填一次吧")
        }
        etHost.addTextChangedListener { detectProto() }

        // TV 上没有返回键的容错空间，崩过就停在配置页把堆栈摆出来，别自动跳进去再崩
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
                btnGo.doOnLayout { btnGo.requestFocus() }
                return
            }
            verifyAndEnter()
        } else {
            // 新配置：焦点落在第一格（地址），遥控器开机直接往下填就行。
            // ⚠️ 必须等布局完再要焦点：onCreate 里就要，视图还是 0×0，
            // 焦点环相关状态会在退化尺寸下被设进去（v1.4.25 实测环变成框顶一根直线）
            etHost.doOnLayout { etHost.requestFocus() }
        }
    }

    private fun setProto(p: String) {
        proto = p
        val on = p == "https"
        chipHttps.setBackgroundResource(if (on) R.drawable.bg_login_chip_on else R.drawable.bg_login_chip)
        chipHttps.setTextColor(getColor(if (on) R.color.accent_soft else R.color.fg_dim))
        chipHttp.setBackgroundResource(if (on) R.drawable.bg_login_chip else R.drawable.bg_login_chip_on)
        chipHttp.setTextColor(getColor(if (on) R.color.fg_dim else R.color.accent_soft))
    }

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
            if (tvErr.visibility != View.VISIBLE) {
                // 错误条淡入：突然蹦出来容易吓一跳，150ms 渐显顺眼
                tvErr.alpha = 0f
                tvErr.visibility = View.VISIBLE
                tvErr.animate().alpha(1f).setDuration(150).start()
            }
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
            val r = withContext(Dispatchers.IO) { runCatching { Api.login(base, user, pass) } }
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
            }.onFailure { e -> showErr(humanErr(e)) }
        }
    }

    // 电视上没人看 logcat，报错必须翻成一句人话
    private fun humanErr(e: Throwable): String {
        val raw = e.message ?: "连接失败"
        return when {
            raw.contains("SSL", true) || raw.contains("certificate", true) || raw.contains("handshake", true) ->
                "https 证书校验失败（自签名证书常见）。改用 http 试试"
            e is java.net.UnknownHostException || raw.contains("Unable to resolve", true) ->
                "找不到这台主机，检查地址拼写 / 电视是否连着同一个网络"
            e is java.net.SocketTimeoutException || e is java.net.ConnectException ->
                "连不上这个地址和端口。确认站点在跑、端口对、电视和服务器能互通"
            else -> raw
        }
    }

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
