package io.github.xiaolurenya.aistream

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.net.http.SslError
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * 全屏 WebView 加载用户自己的 AIStream 站点。
 *
 * 登录态分两层，缺一不可（站点 v71 起页面门禁认 Cookie、API 门禁认 Bearer）：
 *  - Cookie aistream_sid  → 服务端页面门禁（否则 index.html 被改发 gate.html）
 *  - localStorage['aistream_token'] → 前端 app.js / player.js 自己调 /api 接口时带的 Bearer
 * 用 loadDataWithBaseURL 先在目标 origin 上写入 localStorage，再 location.replace 进站，
 * 保证 app.js 第一次执行时 token 已经就位（不用等页面加载完再补一刀刷新）。
 *
 * 会话 7 天过期被弹回 /gate.html 时，自动用保存的账号静默重登一次。
 */
class WebActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private lateinit var gear: TextView
    private var customView: View? = null
    private var customCb: WebChromeClient.CustomViewCallback? = null
    private lateinit var server: String
    private var user = ""
    private var pass = ""
    private var reloginBusy = false
    private val trustedHosts = HashSet<String>()   /* 本次会话内用户点过「继续」的自签证书主机 */

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#0b0d14"))
        setContentView(root)

        val sp = getSharedPreferences("aistream", MODE_PRIVATE)
        server = sp.getString("server", "") ?: ""
        user = sp.getString("user", "") ?: ""
        pass = sp.getString("pass", "") ?: ""
        if (server.isEmpty()) { startActivity(Intent(this, ServerSetupActivity::class.java)); finish(); return }

        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            /* https 站点 + 站方 http 视频源是常态（NAS 自建），混合内容必须放行 */
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            /* 去掉 UA 里的 "; wv" 标记，部分播放源/图床对 WebView UA 下发的内容不同 */
            userAgentString = userAgentString.replace("; wv", "")
        }
        WebView.setWebContentsDebuggingEnabled(false)

        /* 右上角半透明小按钮：横竖屏切换 / 换站点 / 刷新 */
        gear = TextView(this).apply {
            text = "⚙"
            textSize = 18f
            setTextColor(Color.WHITE)
            alpha = 0.30f
            gravity = Gravity.CENTER
            setOnClickListener { showMenu() }
        }
        val gp = FrameLayout.LayoutParams(dp(40), dp(40))
        gp.gravity = Gravity.TOP or Gravity.END
        gp.topMargin = dp(10); gp.rightMargin = dp(10)
        root.addView(gear, gp)

        injectSession(sidFromPrefs())

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                /* 站内地址留在 WebView；外部链接交给系统浏览器 */
                val inSite = u.host != null && server.contains(u.host!!)
                if (u.scheme == "http" || u.scheme == "https") {
                    if (inSite) return false
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: Exception) {}
                    return true
                }
                return true   /* 其他 scheme（magnet 等）不处理 */
            }

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
                /* 家庭 NAS 常见自签证书：问一次，本次会话内记住 */
                val host = try { URL(server).host } catch (_: Exception) { "" }
                if (host.isNotEmpty() && trustedHosts.contains(host)) { handler.proceed(); return }
                AlertDialog.Builder(this@WebActivity)
                    .setTitle("证书不受信任")
                    .setMessage("站点的 HTTPS 证书无效（自签名或域名不匹配）。\n继续访问播放源可能被拦，建议确认后再选。")
                    .setPositiveButton("继续访问") { _, _ -> trustedHosts.add(host); handler.proceed() }
                    .setNegativeButton("取消") { _, _ -> handler.cancel() }
                    .setCancelable(false)
                    .show()
            }

            override fun onPageFinished(view: WebView, url: String) {
                /* 会话过期：站点把页面打回登录页 → 后台静默重登一次 */
                if (url.endsWith("/gate.html") && user.isNotEmpty() && pass.isNotEmpty()) {
                    relogin()
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowCustomView(v: View, cb: CustomViewCallback) {   /* 网页视频全屏 */
                if (customView != null) { cb.onCustomViewHidden(); return }
                customView = v
                web.visibility = View.GONE
                root.addView(v, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                customCb = cb
                /* 全屏看片一律横屏（覆盖手机「自动旋转」关掉的情况）+ 隐藏状态栏/导航栏 */
                gear.visibility = View.GONE
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                hideSystemBars(true)
            }
            override fun onHideCustomView() { exitFullscreen() }
        }

        loadWithSession(sidFromPrefs())
    }

    /* ---------- 登录态 ---------- */

    private fun sidFromPrefs(): String =
        getSharedPreferences("aistream", MODE_PRIVATE).getString("sid", "") ?: ""

    /** 把会话 Cookie 写进 WebView 的 CookieStore（aistream_sid 服务端认；token 同值兜底） */
    private fun injectSession(sid: String) {
        if (sid.isEmpty()) return
        CookieManager.getInstance().setCookie(server, "aistream_sid=$sid; Path=/")
        CookieManager.getInstance().setCookie(server, "token=$sid; Path=/")
        CookieManager.getInstance().flush()
    }

    /** 带 localStorage 种子的进站：先在目标 origin 写 token，再 replace 到首页 */
    private fun loadWithSession(sid: String) {
        injectSession(sid)
        val safeSid = sid.replace("\\", "\\\\").replace("'", "\\'")
        val safeUrl = server.replace("'", "%27")
        val boot = "<script>try{localStorage.setItem('aistream_token','$safeSid');" +
                "localStorage.setItem('aistream_sid','$safeSid');}catch(e){}" +
                "location.replace('$safeUrl/');</script>"
        web.loadDataWithBaseURL(server + "/", boot, "text/html", "utf-8", null)
    }

    /** 会话过期 → 静默重新登录 → 换新 Cookie → 重进站（并发防护：只跑一次） */
    private fun relogin() {
        if (reloginBusy) return
        reloginBusy = true
        Thread {
            var sid: String? = null
            try {
                val body = "{\"username\":\"" + jsonEsc(user) + "\",\"password\":\"" + jsonEsc(pass) + "\"}"
                val c = URL(server + "/api/auth/login").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.connectTimeout = 8000; c.readTimeout = 8000
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray()) }
                if (c.responseCode == 200) {
                    val text = c.inputStream.bufferedReader().readText()
                    sid = Regex("\"token\"\\s*:\\s*\"([^\"]+)\"").find(text)?.groupValues?.lastOrNull()
                }
                c.disconnect()
            } catch (_: Exception) {}
            runOnUiThread {
                reloginBusy = false
                if (sid != null) {
                    getSharedPreferences("aistream", MODE_PRIVATE).edit().putString("sid", sid).apply()
                    loadWithSession(sid!!)
                    Toast.makeText(this, "登录已续期", Toast.LENGTH_SHORT).show()
                }
            }
        }.start()
    }

    /* ---------- 横竖屏 / 菜单 ---------- */

    /** 退出网页全屏：撤掉全屏 view，方向交回用户（跟随系统自动旋转），系统栏放回来 */
    private fun exitFullscreen() {
        customView?.let { root.removeView(it) }
        customView = null
        web.visibility = View.VISIBLE
        customCb?.onCustomViewHidden(); customCb = null
        if (::gear.isInitialized) gear.visibility = View.VISIBLE
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        hideSystemBars(false)
    }

    /** 手动切换横竖屏：现在是横的就切竖，反之切横（跟随重力的横屏，反向横屏也支持） */
    private fun toggleOrientation() {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        requestedOrientation = if (land) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    /** 全屏看片时藏掉状态栏和导航栏，退出全屏再放回来 */
    private fun hideSystemBars(on: Boolean) {
        val c = WindowInsetsControllerCompat(window, window.decorView)
        if (on) {
            c.hide(WindowInsetsCompat.Type.systemBars())
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun showMenu() {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val items = arrayOf(
            if (land) "切回竖屏" else "切到横屏",
            "重新连接 / 换站点",
            "刷新页面"
        )
        AlertDialog.Builder(this)
            .setItems(items) { _, which ->
                when (which) {
                    0 -> toggleOrientation()
                    1 -> startActivity(Intent(this, ServerSetupActivity::class.java))
                    2 -> loadWithSession(sidFromPrefs())   /* 带 token 重新进站，比 reload 稳 */
                }
            }
            .show()
    }

    /* ---------- 返回键 / 销毁 ---------- */

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (customView != null) { exitFullscreen(); return true }
            if (::web.isInitialized && web.canGoBack()) { web.goBack(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            web.apply { loadUrl("about:blank"); clearHistory(); (parent as? ViewGroup)?.removeView(this) }
            web.destroy()
        }
        super.onDestroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density + 0.5f).toInt()

    companion object {
        fun jsonEsc(s: String): String = s.replace("\\", "\\\\").replace("\"", "\\\"")
    }
}
