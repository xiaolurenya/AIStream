package io.github.xiaolurenya.aistream.tv

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.GestureDetector
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.abs

// 直播播放：频道地址走 /api/iptv/stream?ch=，请求必须带上登录 token
class LiveActivity : AppCompatActivity() {

    private val scaleNames = arrayOf("适应", "拉伸", "裁剪")
    private var scaleIdx = 0
    private var idx = 0
    private var ready = false

    /* 取流三档兜底：
       0 = 直连源站（服务端 /api/iptv/stream 只把清单补成绝对地址，流量不过 NAS，最快）
       1 = 服务端代拉（/api/iptv/px 把 master→variant→ts 全包进代理，手机到不了源时靠它）
       2 = 换下一个频道（源本身挂了，跟网页版一样自动顺延） */
    private var stage = 0
    private var autoSw = 0

    private var curCid = ""
    private var curDirect = false

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvTitle: TextView
    private lateinit var tvErr: TextView
    private val ui = Handler(Looper.getMainLooper())

    /* 看门狗：有些源握手成功后就挂在那儿不动，既不报错也不出画面，
       ExoPlayer 自己不会超时（尤其是分片被边写边读时），这里到点就自己往上抬一档 */
    private val watchdog = object : Runnable {
        override fun run() {
            if (!ready) return
            val st = player.playbackState
            if (st == Player.STATE_BUFFERING || st == Player.STATE_IDLE) escalate("连接超时")
        }
    }

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
            // ⚠️ 关键：ExoPlayer 默认的连接/读取超时都只有 8 秒。
            // 直播源（尤其境外台、冷门源）拉一个分片动辄十几秒（实测翡翠台 14s、CCTV13 30s+），
            // 8 秒一到直接抛 Source error —— 这就是「网页版能播、APP 播不了」的主因，
            // 因为网页是浏览器在拉流，没有这条 8 秒硬限制。这里放宽到 15s / 30s。
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
            .setDefaultRequestProperties(mapOf("Accept" to "*/*"))

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        ready = true
        playerView.player = player
        playerView.controllerShowTimeoutMs = 3500
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)

        /* 手势换台：左右快滑 = 上一个/下一个台，双击 = 打开换台列表。
           触摸事件不消费（返回 false），PlayerView 自己那套「点一下出控制条」照常工作。 */
        val gesture = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
                if (e1 == null) return false
                val dx = e2.x - e1.x
                val dy = e2.y - e1.y
                if (abs(dx) > abs(dy) * 1.4f && abs(dx) > 110f) {
                    stepChannel(if (dx < 0) 1 else -1)
                    return true
                }
                return false
            }

            override fun onDoubleTap(e: MotionEvent): Boolean {
                pickChannel()
                return true
            }
        })
        playerView.setOnTouchListener { _, ev ->
            gesture.onTouchEvent(ev)
            false
        }

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    pb.visibility = View.GONE
                    // 出画面了就认定这一档可用，后面再出错从头开始爬
                    autoSw = 0
                    ui.removeCallbacks(watchdog)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                ui.removeCallbacks(watchdog)
                escalate(error.message ?: "源不可用")
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
        ui.removeCallbacks(watchdog)
        if (ready) runCatching { player.pause() }
    }

    override fun onDestroy() {
        ui.removeCallbacks(watchdog)
        if (ready) runCatching { player.release() }
        ready = false
        super.onDestroy()
    }

    private fun pickChannel() {
        val list = PlayCache.iptv
        if (list.isEmpty()) { Toast.makeText(this, "频道列表为空", Toast.LENGTH_SHORT).show(); return }

        /* 频道动辄几千个，AlertDialog.setItems 会一次全实例化直接卡死，
           这里用「搜索框 + RecyclerView」：按台名/分组过滤，顺滑不卡。 */
        val dm = resources.displayMetrics.density
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        box.setPadding((18 * dm).toInt(), (10 * dm).toInt(), (18 * dm).toInt(), 0)

        val et = EditText(this).apply {
            hint = "搜台名或分组"
            setSingleLine(true)
        }
        box.addView(et)

        val rv = RecyclerView(this).apply {
            layoutManager = LinearLayoutManager(this@LiveActivity)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, (420 * dm).toInt()
            )
        }
        box.addView(rv)

        var dlg: AlertDialog? = null
        val ad = ChannelAdapter(
            all = list,
            isCurrent = { p -> p == idx },
            onPick = { pos ->
                dlg?.dismiss()
                idx = pos
                PlayCache.iptvIndex = pos
                stage = 0
                autoSw = 0
                play()
            }
        )
        rv.adapter = ad
        et.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) = ad.filter(s?.toString().orEmpty())
        })

        dlg = AlertDialog.Builder(this)
            .setTitle("换台（${list.size} 个频道）")
            .setView(box)
            .setNegativeButton("关闭", null)
            .show()
    }

    // 左右滑一下就切台：dir=1 下一个，dir=-1 上一个（到头循环）
    private fun stepChannel(dir: Int) {
        val total = PlayCache.iptv.size
        if (total <= 1) return
        idx = ((idx + dir) % total + total) % total
        PlayCache.iptvIndex = idx
        stage = 0
        autoSw = 0
        toast("▶ " + (PlayCache.iptv.getOrNull(idx)?.name.orEmpty()))
        play()
    }

    // 换台列表的行：台名 + 分组，顶部一个搜索框做过滤。
    // 普通 class（不能 inner）：inner 里不允许再声明嵌套的 ViewHolder。
    private class ChannelAdapter(
        private val all: List<Api.IptvCh>,
        private val isCurrent: (Int) -> Boolean,
        private val onPick: (Int) -> Unit
    ) : RecyclerView.Adapter<ChannelAdapter.H>() {

        private val shown = mutableListOf<Int>()
        private var cur = ""

        class H(v: View) : RecyclerView.ViewHolder(v) {
            val name: TextView = v.findViewById(R.id.tvName)
            val group: TextView = v.findViewById(R.id.tvGroup)
        }

        init { filter("") }

        fun filter(q: String) {
            cur = q.trim().lowercase()
            shown.clear()
            all.forEachIndexed { i, c ->
                if (cur.isBlank() ||
                    c.name.orEmpty().lowercase().contains(cur) ||
                    c.group.orEmpty().lowercase().contains(cur)
                ) shown.add(i)
            }
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
            H(LayoutInflater.from(parent.context).inflate(R.layout.item_channel_row, parent, false))

        override fun getItemCount() = shown.size

        override fun onBindViewHolder(h: H, i: Int) {
            val pos = shown[i]
            val c = all[pos]
            h.name.text = c.name.orEmpty()
            h.group.text = c.group.orEmpty()
            // 当前正在播的台给个高亮
            val on = isCurrent(pos)
            h.name.setTextColor(
                h.name.context.getColor(if (on) R.color.accent_soft else R.color.fg)
            )
            h.itemView.setOnClickListener { onPick(pos) }
        }
    }

    // 上一档不行就往上抬；三档都走完才认输
    private fun escalate(reason: String) {
        if (curCid.isBlank()) { showErr(reason); return }
        when (stage) {
            0 -> {
                stage = 1
                pb.visibility = View.VISIBLE
                tvErr.visibility = View.GONE
                toast("直连不通，改用服务端代理重试…")
                play()
            }
            1 -> {
                val total = PlayCache.iptv.size
                if (total > 1 && autoSw < 3) {
                    autoSw++
                    val from = PlayCache.iptv.getOrNull(idx)?.name.orEmpty()
                    idx = (idx + 1) % total
                    PlayCache.iptvIndex = idx
                    stage = 0
                    pb.visibility = View.VISIBLE
                    tvErr.visibility = View.GONE
                    toast("「$from」源不可用，自动切换下一个（$autoSw/3）")
                    play()
                } else showErr(reason)
            }
            else -> showErr(reason)
        }
    }

    private fun showErr(reason: String) {
        pb.visibility = View.GONE
        tvErr.text = "这个频道播不出来：\n$reason\n\n点左下角「换台」手动挑一个，或稍后再试"
        tvErr.visibility = View.VISIBLE
    }

    private fun play() {
        val c = PlayCache.iptv.getOrNull(idx)
        if (c == null) { showErr("没有这个频道"); return }
        curCid = c.cid.orEmpty()
        curDirect = c.direct
        tvTitle.text = c.name.orEmpty() + if (stage >= 1) "（代理）" else ""
        tvErr.visibility = View.GONE
        pb.visibility = View.VISIBLE

        val url = if (stage >= 1) Api.iptvStreamPx(curCid) else Api.iptvStream(curCid)

        /* ⚠️ 第二个坑：/api/iptv/stream?ch=xxx 这种地址没有 .m3u8 后缀。
           ExoPlayer 是「按 URI 后缀推断内容类型」的，没后缀就会被当成普通视频文件
           交给 ProgressiveMediaSource 去解，结果拿一份文本清单去抽帧 → Source error。
           而网页端是显式 new Hls() 再 loadSource，不靠后缀，所以网页能播 APP 不能播。
           这里对非直连频道显式声明是 HLS 清单。直连频道是 mp4/mkv 流，留给 ExoPlayer 嗅探。 */
        val b = MediaItem.Builder().setUri(url)
        if (!curDirect) b.setMimeType(MimeTypes.APPLICATION_M3U8)

        runCatching { player.stop() }
        player.setMediaItem(b.build())
        player.prepare()
        player.playWhenReady = true

        // 25 秒还没出画面就当这档失败，往上抬一档
        ui.removeCallbacks(watchdog)
        ui.postDelayed(watchdog, 25000)
    }

    private fun toast(s: String) =
        Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
