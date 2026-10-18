package io.github.xiaolurenya.aistream.tv

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView

// 直播播放：频道地址走 /api/iptv/stream?ch=，请求必须带上登录 token
class LiveActivity : AppCompatActivity() {

    private val scaleNames = arrayOf("适应", "拉伸", "裁剪")
    private var scaleIdx = 0
    private var idx = 0
    private var ready = false
    private var viaProxy = 0      // 0=直连源站 1=走站点 /api/iptv/px 代理（直连失败时兜底）
    private var curCid = ""
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvTitle: TextView
    private lateinit var tvErr: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_live)

        idx = PlayCache.iptvIndex
        playerView = findViewById(R.id.playerView)
        pb = findViewById(R.id.pb)
        tvTitle = findViewById(R.id.tvTitle)
        tvErr = findViewById(R.id.tvErr)

        // 只带 UA：直播清单会被服务端改写成第三方源的直链，
        // 把站点登录 token 塞进 Authorization 头会一路带给那些 CDN（不安全，有的源还因此拒播）。
        // 站点侧的鉴权用 URL 上的 ?token= 解决（网页端 video 标签也是这么干的）
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(Api.UA)
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(mapOf("Accept" to "*/*"))

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        ready = true
        playerView.player = player
        playerView.controllerShowTimeoutMs = 3500
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)

        player.addListener(object : androidx.media3.common.Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == androidx.media3.common.Player.STATE_READY) pb.visibility = View.GONE
            }

            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                // 直连播不动先别报错：不少直播源只认服务端出网（浏览器直连一样黑屏），
                // 自动切到站点代理通道再试一次，两次都挂才认输
                if (curCid.isNotBlank() && viaProxy == 0) {
                    viaProxy = 1
                    pb.visibility = View.VISIBLE
                    tvErr.visibility = View.GONE
                    play()
                    return
                }
                pb.visibility = View.GONE
                tvErr.text = "这个频道播不出来：" + (error.message ?: "") + "\n换个台或稍后再试"
                tvErr.visibility = View.VISIBLE
            }
        })

        findViewById<View>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<View>(R.id.btnList).setOnClickListener { pickChannel() }
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
        findViewById<View>(R.id.btnRotate).setOnClickListener {
            val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
            requestedOrientation = if (land) ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
            else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        }

        play()
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }

    override fun onPause() {
        super.onPause()
        if (ready) runCatching { player.pause() }
    }

    override fun onDestroy() {
        if (ready) runCatching { player.release() }
        ready = false
        super.onDestroy()
    }

    private fun pickChannel() {
        val list = PlayCache.iptv
        if (list.isEmpty()) { Toast.makeText(this, "频道列表为空", Toast.LENGTH_SHORT).show(); return }
        val names = list.map { it.name.orEmpty() }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("切换频道")
            .setItems(names) { _, w -> idx = w; PlayCache.iptvIndex = w; viaProxy = 0; play() }
            .show()
    }

    private fun play() {
        val c = PlayCache.iptv.getOrNull(idx)
        if (c == null) {
            tvErr.text = "没有这个频道"
            tvErr.visibility = View.VISIBLE
            return
        }
        curCid = c.cid.orEmpty()
        tvTitle.text = c.name.orEmpty()
        tvErr.visibility = View.GONE
        pb.visibility = View.VISIBLE
        val url = if (viaProxy == 1) Api.iptvStreamPx(curCid) else Api.iptvStream(curCid)
        player.setMediaItem(MediaItem.fromUri(url))
        player.prepare()
        player.playWhenReady = true
    }
}
