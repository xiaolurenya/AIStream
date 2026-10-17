package io.github.xiaolurenya.aistream

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * 添加服务器：地址(IP/域名) + 端口 + 用户名 + 密码。
 * 流程：探测站点(GET /api/license/status) → 登录(POST /api/auth/login，服务端 readBody 只认 JSON)
 *      → 拿到 token / 会话 Cookie(aistream_sid) → 保存配置 → 进 WebView。
 * 配置保存在本机 SharedPreferences，不上传任何地方。
 */
class ServerSetupActivity : AppCompatActivity() {

    private lateinit var etHost: EditText
    private lateinit var etPort: EditText
    private lateinit var etUser: EditText
    private lateinit var etPass: EditText
    private lateinit var btnGo: Button
    private lateinit var tvStatus: TextView
    private lateinit var tvClear: TextView
    private lateinit var pb: ProgressBar

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        etHost = findViewById(R.id.etHost)
        etPort = findViewById(R.id.etPort)
        etUser = findViewById(R.id.etUser)
        etPass = findViewById(R.id.etPass)
        btnGo = findViewById(R.id.btnGo)
        tvStatus = findViewById(R.id.tvStatus)
        tvClear = findViewById(R.id.tvClear)
        pb = findViewById(R.id.pb)

        val sp = getSharedPreferences("aistream", MODE_PRIVATE)
        val saved = sp.getString("server", null)
        etHost.setText(sp.getString("host", ""))
        etPort.setText(sp.getInt("port", 8890).toString())
        etUser.setText(sp.getString("user", ""))

        /* 已配置过才显示「清除」入口（换站点用） */
        if (saved != null) {
            tvClear.visibility = View.VISIBLE
            tvClear.setOnClickListener {
                androidx.appcompat.app.AlertDialog.Builder(this)
                    .setTitle("清除已保存的站点")
                    .setMessage("将删除本机保存的地址和登录信息，下次打开 APP 需重新填写。")
                    .setPositiveButton("清除") { _, _ ->
                        sp.edit().clear().apply()
                        startActivity(Intent(this, MainActivity::class.java))
                        finish()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }

        btnGo.setOnClickListener { connect() }
    }

    private fun connect() {
        val raw = etHost.text.toString().trim()
        val host = raw.removePrefix("http://").removePrefix("https://").trimEnd('/')
        val portStr = etPort.text.toString().trim()
        val user = etUser.text.toString().trim()
        val pass = etPass.text.toString()

        if (host.isEmpty()) { tvStatus.text = "请填写服务器地址（IP 或域名）"; return }
        if (user.isEmpty() || pass.isEmpty()) { tvStatus.text = "请填写用户名和密码"; return }
        val port = portStr.toIntOrNull() ?: 8890
        /* 支持直接填完整地址（带 https:// 的域名），填了就以填的为准 */
        val base = if (raw.startsWith("http")) raw.trimEnd('/') else "http://$host:$port"

        btnGo.isEnabled = false
        pb.visibility = View.VISIBLE
        tvStatus.text = "连接中…"

        Thread {
            var err: String? = null
            var sid: String? = null
            try {
                probe("$base/api/license/status")                       /* 1. 站点在线？ */
                sid = login("$base/api/auth/login", user, pass)          /* 2. 登录拿会话 */
                if (sid == null) err = "用户名或密码错误"
            } catch (e: Exception) {
                err = when (e) {
                    is SSLException -> "HTTPS 证书无效（自签名证书）。请先在浏览器确认证书，或改用 http:// 地址"
                    else -> e.message ?: "连接失败"
                }
            }

            runOnUiThread {
                btnGo.isEnabled = true
                pb.visibility = View.GONE
                if (sid == null) {
                    tvStatus.text = "✗ ${err ?: "连接失败"}"
                    Toast.makeText(this, err ?: "连接失败", Toast.LENGTH_LONG).show()
                    return@runOnUiThread
                }
                /* 3. 保存配置，进站 */
                getSharedPreferences("aistream", MODE_PRIVATE).edit()
                    .putString("server", base)
                    .putString("host", host)
                    .putInt("port", port)
                    .putString("user", user)
                    .putString("pass", pass)
                    .putString("sid", sid)
                    .apply()
                tvStatus.text = "✓ 连接成功"
                startActivity(Intent(this, WebActivity::class.java))
                finish()
            }
        }.start()
    }

    /** 探测：非 2xx/3xx 视为不可达 */
    private fun probe(url: String) {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 8000
        c.readTimeout = 8000
        try {
            val code = c.responseCode
            if (code !in 200..399) throw Exception("站点无响应 (HTTP $code)，检查地址和端口")
        } finally { c.disconnect() }
    }

    /** 登录：优先取返回体里的 token（与 aistream_sid 同值），再回落 Set-Cookie */
    private fun login(url: String, user: String, pass: String): String? {
        val body = "{\"username\":\"" + WebActivity.jsonEsc(user) +
                "\",\"password\":\"" + WebActivity.jsonEsc(pass) + "\"}"
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = "POST"
        c.connectTimeout = 8000
        c.readTimeout = 8000
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json")
        try {
            c.outputStream.use { it.write(body.toByteArray()) }
            if (c.responseCode != 200) return null
            val text = c.inputStream.bufferedReader().readText()
            val tk = Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.lastOrNull()
            if (tk != null) return tk
            val cookie = c.getHeaderField("Set-Cookie")
            return Regex("aistream_sid=([^;]+)").find(cookie ?: "")?.groupValues?.lastOrNull()
        } finally { c.disconnect() }
    }
}
