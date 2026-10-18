package io.github.xiaolurenya.aistream.tv

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder
import kotlin.math.abs
import kotlin.math.ceil

class PlayerActivity : AppCompatActivity() {

    private val speeds = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
    private val scaleNames = arrayOf("适应", "拉伸", "裁剪")

    private var lineIdx = 0
    private var epIdx = 0
    private var speedIdx = 1
    private var scaleIdx = 0
    private var lastReport = 0L
    private var playerReady = false

    // 自动跳过片头 / 片尾（能不能跳由后台「跳过片头/片尾」权限决定）
    private var canIntro = false
    private var canOutro = false
    private var introDone = false
    private var outroDone = false
    private var outBlocked = false
    private var lastT = 0L
    private var resuming = false

    // 后台「首页配置 → 自动跳过片头片尾」：开了显示倒计时并自动跳，关了胶囊就是个手动按钮
    private var autoSkip = false
    private var skipAct = 0     // 0=无/会员引导 1=跳过片头 2=下一集

    // 投屏
    private var castUrl = ""
    private var castControl = ""

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvSkip: TextView
    private lateinit var errBar: View
    private lateinit var tvErr: TextView
    private lateinit var topBar: View
    private lateinit var tvTitle: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)

        lineIdx = intent.getIntExtra("line", 0)
        epIdx = intent.getIntExtra("ep", 0)

        playerView = findViewById(R.id.playerView)
        pb = findViewById(R.id.pb)
        errBar = findViewById(R.id.errBar)
        tvErr = findViewById(R.id.tvErr)
        topBar = findViewById(R.id.topBar)
        tvTitle = findViewById(R.id.tvTitle)

        if (PlayCache.lines.isEmpty() && !PlayCache.isUp) {
            tvErr.text = "播放数据已丢失，请退回详情页重新点一次"
            errBar.visibility = View.VISIBLE
            pb.visibility = View.GONE
            return
        }

        // 采集站/解析站普遍看 Referer 和 UA，缺了直接 403；
        // 上游线路是解析出来的第三方地址，不设 Referer（网页端也只带自己页面的）
        val props = HashMap<String, String>()
        props["Accept"] = "*/*"
        if (!PlayCache.isUp) {
            props["Referer"] = refererOf(
                PlayCache.lines.getOrNull(lineIdx)?.eps?.getOrNull(epIdx)?.url.orEmpty()
            )
        }
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(Api.UA)
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(props)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        playerReady = true

        playerView.player = player
        playerView.controllerShowTimeoutMs = 3500
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)
        playerView.setControllerVisibilityListener(
            PlayerView.ControllerVisibilityListener { v ->
                topBar.visibility = if (v == View.VISIBLE) View.VISIBLE else View.GONE
            }
        )

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    pb.visibility = View.GONE
                    resuming = false
                }
                if (state == Player.STATE_ENDED) nextEp()
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                pb.visibility = View.GONE
                showErr("播放失败：" + (error.message ?: "未知错误"))
            }
        })

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<View>(R.id.btnRetry).setOnClickListener { play(lineIdx, epIdx) }
        findViewById<View>(R.id.btnNextLine).setOnClickListener {
            if (PlayCache.isUp) {
                // 上游模式：线路列表 = 智能选择 + 解析面板里那几条，轮着试
                val n = PlayCache.upLines.size + 1
                if (n <= 1) { showErr("这个站点没有列出可换的线路"); return@setOnClickListener }
                PlayCache.upSkip = (PlayCache.upSkip + 1) % n
                upAutoSw = 0
                pb.visibility = View.VISIBLE
                play(lineIdx, epIdx)
                return@setOnClickListener
            }
            val n = PlayCache.lines.size
            if (n <= 1) { showErr("只有这一条线路，没法再换了"); return@setOnClickListener }
            val nx = (lineIdx + 1) % n
            play(nx, if (epIdx < PlayCache.lines[nx].eps.size) epIdx else 0)
        }

        val btnSpeed = findViewById<TextView>(R.id.btnSpeed)
        btnSpeed.setOnClickListener {
            speedIdx = (speedIdx + 1) % speeds.size
            player.playbackParameters = PlaybackParameters(speeds[speedIdx])
            btnSpeed.text = "%.2f".format(speeds[speedIdx]).trimEnd('0').trimEnd('.') + "x"
        }

        findViewById<View>(R.id.btnCast).setOnClickListener { showCast() }
        findViewById<View>(R.id.btnMore).setOnClickListener { showMore(it) }

        // 跳过片头/片尾胶囊：点一下立刻生效，不用等倒计时
        tvSkip = findViewById(R.id.tvSkip)
        tvSkip.setOnClickListener {
            when (skipAct) {
                1 -> {
                    introDone = true
                    runCatching { player.seekTo((SKIP_INTRO_TO * 1000).toLong()) }
                    tvSkip.visibility = View.GONE
                    toast("已跳过片头")
                }
                2 -> {
                    outroDone = true
                    tvSkip.visibility = View.GONE
                    toast("自动播放下一集 ▶")
                    nextEp()
                }
                else -> toast("跳过片头/片尾为会员特权，可在「积分中心」用积分兑换")
            }
        }

        play(lineIdx, epIdx)
        ticker()
        skipWatch()
        loadPerms()
    }

    override fun onResume() {
        super.onResume()
        immersive()
    }

    override fun onPause() {
        if (playerReady) reportHistory()
        super.onPause()
        if (playerReady) runCatching { player.pause() }
    }

    override fun onDestroy() {
        if (playerReady) runCatching { player.release() }
        playerReady = false
        super.onDestroy()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // 按 Home 键时接着在悬浮窗里播（Android 8 以上）
        if (Build.VERSION.SDK_INT >= 26 && playerReady && player.isPlaying) enterPip()
    }

    // 能不能自动跳片头片尾，得看后台给这个账号开的权限 + 自动跳开关
    private fun loadPerms() {
        lifecycleScope.launch {
            val c = withContext(Dispatchers.IO) { runCatching { Api.config() }.getOrNull() }
            canIntro = c?.views?.get("skipIntro") == true
            canOutro = c?.views?.get("skipOutro") == true
            autoSkip = c?.toggles?.get("autoSkip") == true
        }
    }

    private fun immersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }

    private fun refererOf(u: String): String {
        val m = Regex("^(https?://[^/]+)").find(u)
        return if (m != null) m.groupValues[1] + "/" else ""
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun showErr(s: String) {
        tvErr.text = s
        errBar.visibility = View.VISIBLE
    }

    private fun play(line: Int, ep: Int) {
        if (PlayCache.isUp) { playUp(ep); return }
        val ln = PlayCache.lines.getOrNull(line)
        if (ln == null) { showErr("没有可用线路"); return }
        val e = ln.eps.getOrNull(ep)
        if (e == null) { showErr("没有这一集"); return }

        lineIdx = line
        epIdx = ep
        introDone = false
        outroDone = false
        outBlocked = false
        lastT = 0L
        errBar.visibility = View.GONE
        pb.visibility = View.VISIBLE
        tvTitle.text = PlayCache.title + " · " + (e.name ?: ("第" + (ep + 1) + "集"))
        playerView.visibility = View.VISIBLE

        val raw = e.url.orEmpty()
        lifecycleScope.launch {
            val finalUrl = withContext(Dispatchers.IO) { resolveUrl(raw) }
            applyMedia(finalUrl)
        }
    }

    // ---------- 上游模式：分集凭证 → 服务端解析出真实地址 ----------
    // 服务端在 resolve 里已经做完「官方优先 + 体检 + 失败顺延 8 条」，
    // APP 这边只负责把「换线」这个动作喂给它（skip=N），跟网页端 switchLine 一个路数
    private fun playUp(ep: Int) {
        val e = PlayCache.upEps.getOrNull(ep)
        if (e == null) { showErr("没有这一集"); return }

        epIdx = ep
        lineIdx = 0
        introDone = false
        outroDone = false
        outBlocked = false
        lastT = 0L
        errBar.visibility = View.GONE
        pb.visibility = View.VISIBLE
        tvTitle.text = PlayCache.title + " · " + Api.epName(e, ep)
        playerView.visibility = View.VISIBLE

        lifecycleScope.launch {
            val tk = Api.epToken(e)
            if (tk.isBlank()) { showErr("这一集没有播放凭证"); return@launch }
            // 没手动换线时沿用正在播的这条源（keep=线路名）：起播快、画质一致，跟网页端一样
            val keep = if (PlayCache.upSkip == 0 && curLabel.isNotBlank()) curLabel else null
            val r = withContext(Dispatchers.IO) {
                runCatching {
                    Api.upResolve(tk, if (PlayCache.upSkip == 0) 0 else PlayCache.upSkip, keep)
                }.getOrNull()
            }
            if (r == null) { upFail("线路连接超时"); return@launch }
            curLabel = r.label.orEmpty()
            if (curLabel.isNotBlank()) tvTitle.text = PlayCache.title + " · " + Api.epName(e, ep) + " · " + curLabel
            if (r.url.isNullOrBlank()) { upFail(r.error ?: "该线路暂不可用"); return@launch }
            applyMedia(r.url.orEmpty())
        }
    }

    // 换集/重进播放器时清零；同集内失败才累加（网页端 LINE_SKIP/AUTO_SW 同一套口径）
    private var upAutoSw = 0
    private var curLabel = ""

    private fun upFail(reason: String) {
        if (upAutoSw < 3) {
            upAutoSw++
            PlayCache.upSkip = PlayCache.upSkip + 1
            pb.visibility = View.VISIBLE
            toast(reason + "，自动换线 " + upAutoSw + "/3")
            playUp(epIdx)
        } else {
            pb.visibility = View.GONE
            showErr(reason + "，自动换到第 " + upAutoSw + " 条还不行，点「换线路」手动换一条")
        }
    }

    private fun applyMedia(url: String) {
        if (url.isBlank()) {
            pb.visibility = View.GONE
            showErr("这条线路没能解析出播放地址，换一条试试")
            return
        }
        castUrl = url
        // 同一集接着上次看的位置播；换集时 key 变了，自然从头开始
        val saved = Prefs.getProgress(PlayCache.progressKey(PlayCache.title, epIdx))
        var pos = saved.first
        if (saved.second > 0 && pos > saved.second - 15000) pos = 0
        resuming = pos > 1000
        if (resuming) introDone = true    // 续播的不算片头，别刚进来就跳
        player.setMediaItem(MediaItem.fromUri(url), if (pos > 1000) pos else 0L)
        player.prepare()
        player.playWhenReady = true
        lastReport = 0L
    }

    // 直链直接播；不是直链的先过一遍解析线路，再从解析结果里抠真实地址
    private fun resolveUrl(raw: String): String {
        if (Api.isM3u8(raw) || Api.isVideoFile(raw)) return raw
        val p = PlayCache.parseUrl()
        if (p.isNotBlank()) {
            val full = wrapParse(p, raw)
            try {
                val body = Api.fetchText(full)
                if (body.trimStart().startsWith("#EXTM3U")) return full
                val hit = extractPlayable(body)
                if (hit != null) return hit
            } catch (e: Exception) {
                // 解析站自己挂了，接着往下碰运气
            }
        }
        // 没配解析线路（或解析没抠出来）时自己再抓一次：
        // 不少采集站给的是播放页地址，页面里就写着 m3u8，抠出来直接能播
        return try {
            val body = Api.fetchText(raw)
            if (body.trimStart().startsWith("#EXTM3U")) raw
            else extractPlayable(body) ?: raw
        } catch (e: Exception) {
            raw
        }
    }

    // 从解析站 / 播放页返回的内容里找能播的地址
    private fun extractPlayable(body: String): String? {
        val norm = body.replace("\\/", "/")
            .replace("\\u002F", "/")
            .replace("\\u0026", "&")
        val m = RX_M3U8.find(norm) ?: RX_MP4.find(norm) ?: return null
        var s = m.value
        if (s.startsWith("//")) s = "https:" + s
        return s
    }

    private fun wrapParse(purl: String, vurl: String): String {
        val enc = URLEncoder.encode(vurl, "UTF-8")
        // 解析地址自己带了参数名（结尾是 url= 或单个 =）时不能再拼一次 url=，
        // 拼出来会变成 url=url=https%3A...，解析器必然失败
        if (Regex("(\\?|&)url=$").containsMatchIn(purl) || purl.endsWith("=")) return purl + enc
        return purl + (if (purl.contains("?")) "&" else "?") + "url=" + enc
    }

    private fun nextEp() {
        val total = if (PlayCache.isUp) PlayCache.upEps.size
        else PlayCache.lines.getOrNull(lineIdx)?.eps?.size ?: 0
        if (epIdx + 1 < total) {
            upAutoSw = 0          // 换集重新给 3 次自动换线预算（跟网页端 selectEp 一个口径）
            play(lineIdx, epIdx + 1)
        } else {
            pb.visibility = View.GONE
            showErr("已经播完最后一集啦")
        }
    }

    private fun showMore(anchor: View) {
        val pm = PopupMenu(this, anchor)
        pm.inflate(R.menu.player_more)
        pm.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.menu_scale -> nextScale()
                R.id.menu_rotate -> toggleRotate()
                R.id.menu_pip -> enterPip()
                R.id.menu_stop_cast -> stopCast()
            }
            true
        }
        pm.show()
    }

    private fun nextScale() {
        scaleIdx = (scaleIdx + 1) % 3
        playerView.resizeMode = when (scaleIdx) {
            1 -> AspectRatioFrameLayout.RESIZE_MODE_FILL
            2 -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
            else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
        }
        toast("画面：" + scaleNames[scaleIdx])
    }

    private fun toggleRotate() {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        requestedOrientation = if (land) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    private fun enterPip() {
        if (Build.VERSION.SDK_INT >= 26) {
            runCatching { enterPictureInPictureMode(android.app.PictureInPictureParams.Builder().build()) }
                .onFailure { toast("这个设备不支持画中画") }
        } else {
            toast("画中画需要 Android 8.0 以上")
        }
    }

    // ---------- 投屏（SSDP 发现和 SOAP 控制都在服务端，手机只列设备发指令） ----------
    private fun showCast() {
        if (castUrl.isBlank()) { toast("还没拿到播放地址，等一下再试"); return }
        toast("正在扫描局域网投屏设备…")
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.dlnaScan() }.getOrNull() }
            val devs = r?.list.orEmpty().filter { !it.controlUrl.isNullOrBlank() }
            if (devs.isEmpty()) {
                AlertDialog.Builder(this@PlayerActivity)
                    .setTitle(R.string.cast_title)
                    .setMessage(R.string.cast_none)
                    .setPositiveButton("知道了", null)
                    .show()
                return@launch
            }
            val names = devs.map { it.name ?: "未命名设备" }.toTypedArray()
            AlertDialog.Builder(this@PlayerActivity)
                .setTitle(R.string.cast_title)
                .setItems(names) { _, w ->
                    val d = devs[w]
                    doCast(d.controlUrl.orEmpty(), d.name ?: "设备")
                }
                .show()
        }
    }

    private fun doCast(controlUrl: String, name: String) {
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { Api.dlnaCast(controlUrl, castUrl, PlayCache.title) }.getOrNull()
            }
            if (r?.ok == true) {
                castControl = controlUrl
                runCatching { player.pause() }
                toast("已投屏到 $name")
            } else {
                toast("投屏失败：" + (r?.error ?: "设备没响应"))
            }
        }
    }

    private fun stopCast() {
        if (castControl.isBlank()) { toast("当前没有在投屏"); return }
        lifecycleScope.launch {
            withContext(Dispatchers.IO) { runCatching { Api.dlnaStop(castControl) } }
            castControl = ""
            toast("已停止投屏")
        }
    }

    // ---------- 自动跳过片头 / 片尾（跟网页端 player.js 同一套判定、同一套文案） ----------
    private fun skipWatch() {
        lifecycleScope.launch {
            while (true) {
                delay(1000)
                if (!playerReady || !player.isPlaying) continue
                val t = player.currentPosition / 1000.0
                val dur = player.duration / 1000.0
                if (dur <= 0) continue

                // 用户手动拖进度条时别把「拖到片尾」当成播到片尾
                if (dur > 60 && t > dur * 0.8 && abs(t - lastT) > 2) outBlocked = true
                // 网页端同款「自然播放」判定：进度在往前慢慢走才算，跳变不算
                val natural = t - lastT >= 0 && t - lastT < 2

                val epTotal = if (PlayCache.isUp) PlayCache.upEps.size
                else PlayCache.lines.getOrNull(lineIdx)?.eps?.size ?: 0
                val isMovie = PlayCache.isMovie(epTotal)
                val autoIn = autoSkip && !isMovie
                val introZone = t >= 3 && t < SKIP_INTRO_TO - 5
                val guard = minOf(100.0, maxOf(12.0, dur * 0.10))
                val outZone = dur > 60 && t > 30 && dur - t <= guard && dur - t > 3 && epIdx < epTotal - 1
                val outAuto = outZone && !outBlocked

                // 自动模式：自然播放进区间才触发，每集各一次；固定第 20 秒跳到 100 秒
                if (autoIn && canIntro && !introDone && natural && introZone && !resuming && t >= SKIP_INTRO_AT) {
                    introDone = true
                    runCatching { player.seekTo((SKIP_INTRO_TO * 1000).toLong()) }
                    lastT = SKIP_INTRO_TO.toLong()
                    tvSkip.visibility = View.GONE
                    toast("已自动跳过片头 ▶")
                    continue
                }
                if (autoSkip && canOutro && !outroDone && natural && outAuto) {
                    outroDone = true
                    tvSkip.visibility = View.GONE
                    toast("已自动跳过片尾 · 播放下一集 ▶")
                    nextEp()
                    continue
                }

                // 胶囊：自动模式显示倒计时（点了立刻跳不等倒计时），手动模式就是个按钮，
                // 没权限显示会员引导 —— 文案跟网页端一字不差
                when {
                    introZone -> {
                        tvSkip.text = when {
                            !canIntro -> "👑 会员专享 · 跳过片头"
                            autoIn -> "即将自动跳过片头 " + maxOf(1, ceil(SKIP_INTRO_AT - t).toInt()) + "s ⏭"
                            else -> "跳过片头 ⏭"
                        }
                        skipAct = if (canIntro) 1 else 0
                        tvSkip.visibility = View.VISIBLE
                    }
                    outZone -> {
                        val showAuto = autoSkip && canOutro && !outBlocked
                        tvSkip.text = when {
                            !canOutro -> "👑 会员专享 · 跳过片尾"
                            showAuto -> "即将自动跳过片尾 · 下一集 ⏭"
                            else -> "跳过片尾 · 下一集 ⏭"
                        }
                        skipAct = if (canOutro) 2 else 0
                        tvSkip.visibility = View.VISIBLE
                    }
                    else -> tvSkip.visibility = View.GONE
                }
                lastT = t.toLong()
            }
        }
    }

    // 进度落本机 + 定期把观看记录报给站点（网页端历史里能看到）
    private fun ticker() {
        lifecycleScope.launch {
            while (true) {
                delay(4000)
                if (playerReady && player.duration > 0 && player.currentPosition > 0) {
                    Prefs.putProgress(
                        PlayCache.progressKey(PlayCache.title, epIdx),
                        player.currentPosition,
                        player.duration
                    )
                }
                val now = System.currentTimeMillis()
                if (playerReady && player.isPlaying && now - lastReport > 15000) {
                    lastReport = now
                    reportHistory()
                }
            }
        }
    }

    private fun reportHistory() {
        if (PlayCache.title.isBlank() || !playerReady) return
        val epTotal = if (PlayCache.isUp) PlayCache.upEps.size
        else PlayCache.lines.getOrNull(lineIdx)?.eps?.size ?: return
        if (epTotal <= 0) return
        val pos = (player.currentPosition / 1000).coerceAtLeast(0)
        val dur = (player.duration / 1000).coerceAtLeast(0)
        if (dur <= 0) return
        val item = Api.HistItem(
            id = PlayCache.itemId,
            title = PlayCache.title,
            poster = PlayCache.poster,
            year = PlayCache.year,
            ep = (epIdx + 1).toString(),
            epTotal = epTotal.toString(),
            pos = pos.toString(),
            dur = dur.toString()
        )
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching { Api.postHistory(item) }
        }
    }

    companion object {
        // 跟网页端同一组数值：20 秒后、100 秒前算片头，直接跳到第 100 秒
        const val SKIP_INTRO_AT = 20.0
        const val SKIP_INTRO_TO = 100.0

        private val RX_M3U8 = Regex("""(https?:)?//[^"'\s<>]+?\.m3u8[^"'\s<>]*""")
        private val RX_MP4 = Regex("""(https?:)?//[^"'\s<>]+?\.(mp4|flv)(\?[^"'\s<>]*)?""")
    }
}
