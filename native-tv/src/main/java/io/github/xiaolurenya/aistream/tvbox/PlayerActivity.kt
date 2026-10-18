package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
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
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder
import kotlin.math.abs

/* TV 播放器。遥控器映射：
   确认键 = 暂停/继续｜左右键 = 快退/快进 10 秒｜上下键 = 呼出进度条
   菜单键 = 选集面板｜音量键 = 调系统音量（并给个百分比提示）
   TV 版不做投屏、画中画、旋转，只在底部留一个「全屏」按钮切换画面铺满/适应。 */
class PlayerActivity : AppCompatActivity() {

    private val speeds = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
    private var speedIdx = 1
    private var filled = false        // true = 铺满全屏，false = 原始比例适应

    private var lineIdx = 0
    private var epIdx = 0
    private var playerReady = false
    private var lastReport = 0L

    private var upAutoSw = 0
    private var curLabel = ""

    // 自动跳过片头 / 片尾（能不能跳由后台权限决定）
    private var canIntro = false
    private var canOutro = false
    private var autoSkip = false
    private var introDone = false
    private var outroDone = false
    private var outBlocked = false
    private var lastT = 0L
    private var resuming = false

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvErr: TextView
    private lateinit var tvTitle: TextView
    private lateinit var barTop: View
    private lateinit var barBtns: View
    private lateinit var epPanel: View
    private lateinit var rvEps: RecyclerView
    private lateinit var btnFull: TextView
    private lateinit var btnSpeed: TextView
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)

        lineIdx = intent.getIntExtra("line", 0)
        epIdx = intent.getIntExtra("ep", 0)

        playerView = findViewById(R.id.playerView)
        pb = findViewById(R.id.pb)
        tvErr = findViewById(R.id.tvErr)
        tvTitle = findViewById(R.id.tvTitle)
        barTop = findViewById(R.id.barTop)
        barBtns = findViewById(R.id.barBtns)
        epPanel = findViewById(R.id.epPanel)
        rvEps = findViewById(R.id.rvEps)
        btnFull = findViewById(R.id.btnFull)
        btnSpeed = findViewById(R.id.btnSpeed)

        if (PlayCache.lines.isEmpty() && !PlayCache.isUp) {
            showErr("播放数据已丢失，请退回详情页重新点一次")
            pb.visibility = View.GONE
            return
        }

        // 采集站/解析站普遍看 Referer，缺了直接 403；上游线路是第三方地址，不带 Referer
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
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
            .setDefaultRequestProperties(props)

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        playerReady = true

        playerView.player = player
        playerView.controllerShowTimeoutMs = 6000
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)
        playerView.setControllerVisibilityListener(
            PlayerView.ControllerVisibilityListener { v ->
                val show = v == View.VISIBLE
                barTop.visibility = if (show) View.VISIBLE else View.INVISIBLE
                barBtns.visibility = if (show) View.VISIBLE else View.INVISIBLE
            }
        )

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) { pb.visibility = View.GONE; resuming = false }
                if (state == Player.STATE_ENDED) nextEp()
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                pb.visibility = View.GONE
                showErr("播放失败：" + (error.message ?: "未知错误"))
            }
        })

        rvEps.layoutManager = GridLayoutManager(this, 3)
        noAnim(rvEps)

        findViewById<View>(R.id.btnLine).setOnClickListener { nextLine() }
        findViewById<View>(R.id.btnEps).setOnClickListener { toggleEps() }
        btnFull.setOnClickListener { toggleFull() }
        btnSpeed.setOnClickListener {
            speedIdx = (speedIdx + 1) % speeds.size
            player.playbackParameters = PlaybackParameters(speeds[speedIdx])
            btnSpeed.text = "%.2f".format(speeds[speedIdx]).trimEnd('0').trimEnd('.') + "x"
        }
        for (id in intArrayOf(R.id.btnFull, R.id.btnLine, R.id.btnEps, R.id.btnSpeed)) {
            val b = findViewById<View>(id)
            bindFocus(b) { has -> b.alpha = if (has) 1f else 0.85f }
        }

        play(lineIdx, epIdx)
        ticker()
        skipWatch()
        loadPerms()
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
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

    // ---------- 遥控器按键 ----------
    override fun dispatchKeyEvent(ev: KeyEvent): Boolean {
        if (ev.action == KeyEvent.ACTION_DOWN) {
            // 焦点已经在播放器控制条/选集面板里时，一切交给它们，别抢
            if (focusInPlayer() || (epPanel.visibility == View.VISIBLE && focusInPanel())) {
                return super.dispatchKeyEvent(ev)
            }
            when (ev.keyCode) {
                KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    // 系统自己会调音量，这里只是把百分比摆出来给个反馈
                    ui.postDelayed({ showVolume() }, 150)
                    return false
                }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER,
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SPACE -> {
                    togglePlay()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_LEFT -> { seekBy(-10000); return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { seekBy(10000); return true }
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN -> {
                    playerView.showController()
                    return super.dispatchKeyEvent(ev)
                }
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_BUTTON_Y -> { toggleEps(); return true }
                KeyEvent.KEYCODE_BACK -> {
                    if (epPanel.visibility == View.VISIBLE) { toggleEps(); return true }
                }
            }
        }
        return super.dispatchKeyEvent(ev)
    }

    // 焦点（或其任一祖先）是不是落在这个 view 里
    private fun focusIn(view: View): Boolean {
        var n: View? = currentFocus ?: return false
        while (n != null) {
            if (n === view) return true
            n = n.parent as? View
        }
        return false
    }

    private fun focusInPlayer(): Boolean = focusIn(playerView)

    private fun focusInPanel(): Boolean = focusIn(epPanel)

    private fun togglePlay() {
        if (!playerReady) return
        player.playWhenReady = !player.playWhenReady
        toast(if (player.playWhenReady) "▶ 播放" else "⏸ 暂停")
    }

    private fun seekBy(ms: Long) {
        if (!playerReady) return
        val t = (player.currentPosition + ms).coerceIn(0, player.duration.coerceAtLeast(0))
        player.seekTo(t)
        playerView.showController()
    }

    private fun showVolume() {
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        toast("音量 ${cur * 100 / max}%")
    }

    private fun toggleFull() {
        filled = !filled
        playerView.resizeMode = if (filled) AspectRatioFrameLayout.RESIZE_MODE_FILL
        else AspectRatioFrameLayout.RESIZE_MODE_FIT
        btnFull.text = if (filled) "适应" else "全屏"
    }

    private fun toggleEps() {
        if (epPanel.visibility == View.VISIBLE) {
            epPanel.visibility = View.GONE
            return
        }
        val names: List<String> = if (PlayCache.isUp)
            PlayCache.upEps.mapIndexed { i, e -> Api.epName(e, i) }
        else PlayCache.lines.getOrNull(lineIdx)?.eps?.mapIndexed { i, e -> e.name ?: "第${i + 1}集" }.orEmpty()
        if (names.isEmpty()) { toast("还没有分集列表"); return }
        rvEps.adapter = ChipAdapter(names, { epIdx }) { i ->
            epIdx = i
            epPanel.visibility = View.GONE
            play(lineIdx, epIdx)
        }
        epPanel.visibility = View.VISIBLE
        // 面板本身是个容器拿不到焦点，得把焦点递给第一张卡，否则确认键会被页面当成「播放/暂停」
        rvEps.post {
            val first = rvEps.getChildAt(0)
            if (first != null) first.requestFocus() else rvEps.requestFocus()
        }
    }

    // ---------- 取权限 ----------
    private fun loadPerms() {
        lifecycleScope.launch {
            val c = withContext(Dispatchers.IO) { runCatching { Api.config() }.getOrNull() }
            // 取不到配置就按「有权限」放行，别把会员功能锁死
            if (c == null) {
                canIntro = true; canOutro = true; autoSkip = true
                return@launch
            }
            canIntro = Api.flag(c.views, "skipIntro", true)
            canOutro = Api.flag(c.views, "skipOutro", true)
            autoSkip = Api.flag(c.toggles, "autoSkip", true)
        }
    }

    private fun refererOf(u: String): String {
        val m = Regex("^(https?://[^/]+)").find(u)
        return if (m != null) m.groupValues[1] + "/" else ""
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    private fun showErr(s: String) {
        tvErr.text = s
        tvErr.visibility = View.VISIBLE
    }

    private fun play(line: Int, ep: Int) {
        if (PlayCache.isUp) { playUp(ep); return }
        val ln = PlayCache.lines.getOrNull(line)
        if (ln == null) { showErr("没有可用线路"); return }
        val e = ln.eps.getOrNull(ep)
        if (e == null) { showErr("没有这一集"); return }

        lineIdx = line
        epIdx = ep
        resetSkip()
        tvTitle.text = PlayCache.title + " · " + (e.name ?: ("第" + (ep + 1) + "集"))

        val raw = e.url.orEmpty()
        lifecycleScope.launch {
            val finalUrl = withContext(Dispatchers.IO) { resolveUrl(raw) }
            applyMedia(finalUrl)
        }
    }

    private fun resetSkip() {
        introDone = false
        outroDone = false
        outBlocked = false
        lastT = 0L
        tvErr.visibility = View.GONE
        pb.visibility = View.VISIBLE
    }

    private fun playUp(ep: Int) {
        val e = PlayCache.upEps.getOrNull(ep)
        if (e == null) { showErr("没有这一集"); return }

        epIdx = ep
        lineIdx = 0
        resetSkip()
        tvTitle.text = PlayCache.title + " · " + Api.epName(e, ep)

        lifecycleScope.launch {
            val tk = Api.epToken(e)
            if (tk.isBlank()) { showErr("这一集没有播放凭证"); return@launch }
            // 没手动换线时沿用正在播的这条源（keep=线路名）：起播快、画质一致
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

    private fun upFail(reason: String) {
        if (upAutoSw < 3) {
            upAutoSw++
            PlayCache.upSkip = PlayCache.upSkip + 1
            pb.visibility = View.VISIBLE
            toast(reason + "，自动换线 " + upAutoSw + "/3")
            playUp(epIdx)
        } else {
            pb.visibility = View.GONE
            showErr(reason + "，自动换到第 " + upAutoSw + " 条还不行，按「换线路」手动换一条")
        }
    }

    private fun applyMedia(url: String) {
        if (url.isBlank()) {
            pb.visibility = View.GONE
            showErr("这条线路没能解析出播放地址，按「换线路」换一条")
            return
        }
        val saved = Prefs.getProgress(PlayCache.progressKey(PlayCache.title, epIdx))
        var pos = saved.first
        if (saved.second > 0 && pos > saved.second - 15000) pos = 0
        resuming = pos > 1000
        if (resuming) introDone = true      // 续播的不算片头，别刚进来就跳
        player.setMediaItem(MediaItem.fromUri(url), if (pos > 1000) pos else 0L)
        player.prepare()
        player.playWhenReady = true
        lastReport = 0L
    }

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
            } catch (e: Exception) { /* 解析站自己挂了，接着往下碰运气 */ }
        }
        return try {
            val body = Api.fetchText(raw)
            if (body.trimStart().startsWith("#EXTM3U")) raw
            else extractPlayable(body) ?: raw
        } catch (e: Exception) { raw }
    }

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

    private fun nextLine() {
        if (PlayCache.isUp) {
            val n = PlayCache.upLines.size + 1
            if (n <= 1) { toast("这个站点没有列出可换的线路"); return }
            PlayCache.upSkip = (PlayCache.upSkip + 1) % n
            upAutoSw = 0
            pb.visibility = View.VISIBLE
            play(lineIdx, epIdx)
            return
        }
        val n = PlayCache.lines.size
        if (n <= 1) { toast("只有这一条线路，没法再换了"); return }
        val nx = (lineIdx + 1) % n
        play(nx, if (epIdx < PlayCache.lines[nx].eps.size) epIdx else 0)
    }

    private fun nextEp() {
        val total = if (PlayCache.isUp) PlayCache.upEps.size
        else PlayCache.lines.getOrNull(lineIdx)?.eps?.size ?: 0
        if (epIdx + 1 < total) {
            upAutoSw = 0
            play(lineIdx, epIdx + 1)
        } else {
            pb.visibility = View.GONE
            showErr("已经播完最后一集啦")
        }
    }

    // ---------- 自动跳过片头 / 片尾（跟网页端 player.js 同一套判定） ----------
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

                if (autoIn && canIntro && !introDone && natural && introZone && !resuming && t >= SKIP_INTRO_AT) {
                    introDone = true
                    runCatching { player.seekTo((SKIP_INTRO_TO * 1000).toLong()) }
                    lastT = SKIP_INTRO_TO.toLong()
                    toast("已自动跳过片头 ▶")
                    continue
                }
                if (autoSkip && canOutro && !outroDone && natural && outAuto) {
                    outroDone = true
                    toast("已自动跳过片尾 · 播放下一集 ▶")
                    nextEp()
                    continue
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
        lifecycleScope.launch(Dispatchers.IO) { runCatching { Api.postHistory(item) } }
    }

    companion object {
        // 跟网页端同一组数值：20 秒后、100 秒前算片头，直接跳到第 100 秒
        const val SKIP_INTRO_AT = 20.0
        const val SKIP_INTRO_TO = 100.0

        private val RX_M3U8 = Regex("""(https?:)?//[^"'\s<>]+?\.m3u8[^"'\s<>]*""")
        private val RX_MP4 = Regex("""(https?:)?//[^"'\s<>]+?\.(mp4|flv)(\?[^"'\s<>]*)?""")
    }
}
