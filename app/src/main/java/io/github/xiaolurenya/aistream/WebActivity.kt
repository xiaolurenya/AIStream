package io.github.xiaolurenya.aistream

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
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
 *
 * 悬浮球（⚙）可以拖到屏幕任意位置，位置记在本机，别挡网页内容；点一下出菜单。
 * 横屏自动进入沉浸（藏状态栏/导航栏），配合站点 v74 的横屏影院模式看片。
 */
class WebActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private lateinit var gear: TextView
    private lateinit var progress: ProgressBar
    private var customView: View? = null
    private var customCb: WebChromeClient.CustomViewCallback? = null
    private lateinit var server: String
    private var user = ""
    private var pass = ""
    private var reloginBusy = false
    private val trustedHosts = HashSet<String>()   /* 本次会话内用户点过「继续」的自签证书主机 */

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
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
            /* ---------- 加载速度 / 流畅度 ---------- */
            cacheMode = WebSettings.LOAD_DEFAULT                  /* 图片等静态资源吃磁盘缓存 */
            if (Build.VERSION.SDK_INT >= 23) offscreenPreRaster = true   /* 离屏预渲染，切入前台少白屏 */
            if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = false /* 省一次 SafeBrowsing 联网检查，内网站也少误报 */
            if (Build.VERSION.SDK_INT >= 26) {
                /* 渲染进程别省电：看片时被系统降级会卡成幻灯片 */
                web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
            }
        }
        WebView.setWebContentsDebuggingEnabled(false)

        /* 顶部加载进度条：细一条，满格自动消失 */
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#00e5ff"))
            progressBackgroundTintList = android.content.res.ColorStateList.valueOf(Color.parseColor("#1a2233"))
        }
        root.addView(progress, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(3)))

        /* 悬浮球 ⚙：可拖动，位置记忆在本机；点一下出菜单 */
        gear = TextView(this).apply {
            text = "⚙"
            textSize = 15f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            alpha = 0.38f
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0x59060b18)
                setStroke(dp(1), 0x33667a99)
            }
        }
        root.addView(gear, gearParams(sp))
        gear.setOnTouchListener { _, ev -> dragGear(ev, sp) }

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

            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
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
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                if (customView != null) return          /* 全屏看片时不显示进度条 */
                progress.progress = newProgress
                progress.visibility = if (newProgress >= 100) View.GONE else View.VISIBLE
            }

            override fun onShowCustomView(v: View, cb: CustomViewCallback) {   /* 网页视频全屏 */
                if (customView != null) { cb.onCustomViewHidden(); return }
                customView = v
                web.visibility = View.GONE
                progress.visibility = View.GONE
                gear.visibility = View.GONE
                root.addView(v, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                customCb = cb
                /* 全屏看片一律横屏（覆盖手机「自动旋转」关掉的情况）+ 隐藏状态栏/导航栏 */
                requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                hideSystemBars(true)
            }
            override fun onHideCustomView() { exitFullscreen() }
        }

        loadWithSession(sidFromPrefs())
    }

    /* ---------- 悬浮球：拖动 + 记忆位置 ---------- */

    private fun gearParams(sp: android.content.SharedPreferences): FrameLayout.LayoutParams {
        val lp = FrameLayout.LayoutParams(dp(34), dp(34))
        lp.gravity = Gravity.TOP or Gravity.START
        val dm = resources.displayMetrics
        val savedX = sp.getInt("gear_x", Int.MIN_VALUE)
        val savedY = sp.getInt("gear_y", Int.MIN_VALUE)
        /* 没存过：右上角但往下让开网页顶部导航（大哥反馈 ⚙ 挡住了「动漫」标签） */
        lp.leftMargin = if (savedX != Int.MIN_VALUE) savedX else dm.widthPixels - dp(42)
        lp.topMargin = if (savedY != Int.MIN_VALUE) savedY else dp(92)
        /* 屏幕旋转/换机后可能出界，收回来 */
        lp.leftMargin = lp.leftMargin.coerceIn(0, maxOf(0, dm.widthPixels - dp(40)))
        lp.topMargin = lp.topMargin.coerceIn(0, maxOf(0, dm.heightPixels - dp(60)))
        return lp
    }

    private var dragFromX = 0f; private var dragFromY = 0f
    private var gearFromX = 0; private var gearFromY = 0
    private var dragged = false

    private fun dragGear(ev: MotionEvent, sp: android.content.SharedPreferences): Boolean {
        val lp = gear.layoutParams as FrameLayout.LayoutParams
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragFromX = ev.rawX; dragFromY = ev.rawY
                gearFromX = lp.leftMargin; gearFromY = lp.topMargin
                dragged = false
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = (ev.rawX - dragFromX).toInt(); val dy = (ev.rawY - dragFromY).toInt()
                if (dragged || dx * dx + dy * dy > 100) {       /* 10px 内算点按，不抖 */
                    dragged = true
                    val dm = resources.displayMetrics
                    lp.leftMargin = (gearFromX + dx).coerceIn(0, dm.widthPixels - gear.width)
                    lp.topMargin = (gearFromY + dy).coerceIn(0, dm.heightPixels - gear.height)
                    gear.layoutParams = lp
                }
            }
            MotionEvent.ACTION_UP -> {
                if (dragged) {                                   /* 拖完记位置，下次还在这 */
                    sp.edit().putInt("gear_x", lp.leftMargin).putInt("gear_y", lp.topMargin).apply()
                    return true
                }
                showMenu()                                       /* 没拖 = 点按 */
            }
        }
        return dragged
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

    /* ---------- 横竖屏 / 沉浸 / 菜单 ---------- */

    /* 手动切横竖屏、网页全屏进出都会走到这：横屏自动藏系统栏，竖屏放回来。
       横屏的「影院模式」由站点 v74 的 CSS 负责（顶栏/防上当条收起、播放器铺满整屏）。 */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (customView != null) return               /* 全屏看片中，方向由全屏逻辑管 */
        hideSystemBars(newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE)
    }

    /** 退出网页全屏：撤掉全屏 view，方向交回重力（四个方向都允许），系统栏放回来 */
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

    /** 全屏看片 / 横屏时藏掉状态栏和导航栏，退出再放回来 */
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
