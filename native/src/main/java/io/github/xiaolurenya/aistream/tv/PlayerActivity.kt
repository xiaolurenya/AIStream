package io.github.xiaolurenya.aistream.tv

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URLEncoder

class PlayerActivity : AppCompatActivity() {

    private val speeds = floatArrayOf(0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
    private val RX_M3U8 = Regex("""(https?:)?//[^"'\s<>]+?\.m3u8[^"'\s<>]*""")
    private val RX_MP4 = Regex("""(https?:)?//[^"'\s<>]+?\.(mp4|flv)(\?[^"'\s<>]*)?""")
    private val scaleNames = arrayOf("适应", "拉伸", "裁剪")

    private var lineIdx = 0
    private var epIdx = 0
    private var speedIdx = 1
    private var scaleIdx = 0
    private var lastReport = 0L
    private var playerReady = false

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
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

        if (PlayCache.lines.isEmpty()) {
            tvErr.text = "播放数据已丢失，请退回详情页重新点一次"
            errBar.visibility = View.VISIBLE
            pb.visibility = View.GONE
            return
        }

        // 采集站/解析站普遍看 Referer 和 UA，缺了直接 403
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(Api.UA)
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(
                mapOf(
                    "Referer" to refererOf(
                        PlayCache.lines.getOrNull(lineIdx)?.eps?.getOrNull(epIdx)?.url.orEmpty()
                    ),
                    "Accept" to "*/*"
                )
            )

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
                if (state == Player.STATE_READY) pb.visibility = View.GONE
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
            val n = PlayCache.lines.size
            if (n <= 1) { showErr("只有这一条线路，没法再换了"); return@setOnClickListener }
            val nx = (lineIdx + 1) % n
            play(nx, if (epIdx < PlayCache.lines[nx].eps.size) epIdx else 0)
        }

        val btnSpeed = findViewById<TextView>(R.id.btnSpeed)
        btnSpeed.setOnClickListener {
            speedIdx = (speedIdx + 1) % speeds.size
            player.playbackParameters = PlaybackParameters(speeds[speedIdx])
            btnSpeed.text = "%.2fx".format(speeds[speedIdx]).trimEnd('0').trimEnd('.') + "x"
        }

        val btnScale = findViewById<TextView>(R.id.btnScale)
        btnScale.setOnClickListener {
            scaleIdx = (scaleIdx + 1) % 3
            playerView.resizeMode = when (scaleIdx) {
                1 -> AspectRatioFrameLayout.RESIZE_MODE_FILL
                2 -> AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                else -> AspectRatioFrameLayout.RESIZE_MODE_FIT
            }
            btnScale.text = scaleNames[scaleIdx]
        }

        findViewById<View>(R.id.btnRotate).setOnClickListener { toggleRotate() }

        play(lineIdx, epIdx)
        ticker()
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
        if (Build.VERSION.SDK_INT >= 26 && playerReady && player.isPlaying) {
            runCatching { enterPictureInPictureMode(android.app.PictureInPictureParams.Builder().build()) }
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

    private fun showErr(s: String) {
        tvErr.text = s
        errBar.visibility = View.VISIBLE
    }

    private fun play(line: Int, ep: Int) {
        val ln = PlayCache.lines.getOrNull(line)
        if (ln == null) { showErr("没有可用线路"); return }
        val e = ln.eps.getOrNull(ep)
        if (e == null) { showErr("没有这一集"); return }

        lineIdx = line
        epIdx = ep
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

    private fun applyMedia(url: String) {
        if (url.isBlank()) {
            pb.visibility = View.GONE
            showErr("这条线路没能解析出播放地址，换一条试试")
            return
        }
        // 同一集接着上次看的位置播；换集时 key 变了，自然从头开始
        val saved = Prefs.getProgress(PlayCache.progressKey(PlayCache.title, epIdx))
        var pos = saved.first
        if (saved.second > 0 && pos > saved.second - 15000) pos = 0
        player.setMediaItem(MediaItem.fromUri(url), if (pos > 1000) pos else 0L)
        player.prepare()
        player.playWhenReady = true
        lastReport = 0L
    }

    // 直链直接播；不是直链的先过一遍解析线路，再从解析结果里抠真实地址
    private fun resolveUrl(raw: String): String {
        if (Api.isM3u8(raw) || Api.isVideoFile(raw)) return raw
        val p = PlayCache.parseList.firstOrNull()?.url
        if (!p.isNullOrBlank()) {
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
        val norm = body.replace("\\/", "/").replace("\\u002F", "/").replace("&amp;", "&")
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
        val ln = PlayCache.lines.getOrNull(lineIdx) ?: return
        if (epIdx + 1 < ln.eps.size) {
            play(lineIdx, epIdx + 1)
        } else {
            pb.visibility = View.GONE
            showErr("已经播完最后一集啦")
        }
    }

    private fun toggleRotate() {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        requestedOrientation = if (land) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
        else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    // 进度落本机 + 定期把观看记录报给站点（网页端历史里能看到）
    private fun ticker() {
        lifecycleScope.launch {
            while (true) {
                delay(4000)
                if (player.duration > 0 && player.currentPosition > 0) {
                    Prefs.putProgress(
                        PlayCache.progressKey(PlayCache.title, epIdx),
                        player.currentPosition,
                        player.duration
                    )
                }
                val now = System.currentTimeMillis()
                if (player.isPlaying && now - lastReport > 15000) {
                    lastReport = now
                    reportHistory()
                }
            }
        }
    }

    private fun reportHistory() {
        if (PlayCache.title.isBlank()) return
        val ln = PlayCache.lines.getOrNull(lineIdx) ?: return
        val pos = (player.currentPosition / 1000).coerceAtLeast(0)
        val dur = (player.duration / 1000).coerceAtLeast(0)
        if (dur <= 0) return
        val item = Api.HistItem(
            id = PlayCache.itemId,
            title = PlayCache.title,
            poster = PlayCache.poster,
            year = PlayCache.year,
            ep = (epIdx + 1).toString(),
            epTotal = ln.eps.size.toString(),
            pos = pos.toString(),
            dur = dur.toString()
        )
        lifecycleScope.launch(Dispatchers.IO) {
            runCatching { Api.postHistory(item) }
        }
    }
}
