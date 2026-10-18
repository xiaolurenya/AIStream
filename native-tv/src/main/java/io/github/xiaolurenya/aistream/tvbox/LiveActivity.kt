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
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/* TV 直播。遥控器映射：
   上下键 = 上一个台/下一个台｜左右键 = 开/关频道单｜确认键 = 呼出频道单
   菜单键 = 频道单｜音量键 = 调系统音量＋百分比提示
   取流三档兜底：直连源站 → 服务端代拉 → 换下一个频道（跟手机版同一套）。 */
class LiveActivity : AppCompatActivity() {

    private var idx = 0
    private var ready = false

    private var stage = 0
    private var autoSw = 0
    private var curCid = ""
    private var curDirect = false

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvTitle: TextView
    private lateinit var tvErr: TextView
    private lateinit var chPanel: View
    private lateinit var rvCh: RecyclerView
    private lateinit var btnCh: TextView
    private lateinit var btnClosePanel: TextView
    private lateinit var tvEpgNow: TextView
    private lateinit var tvEpgNext: TextView
    private val ui = Handler(Looper.getMainLooper())

    // 看门狗：有些源握手成功后就挂在那儿不动，既不报错也不出画面，到点就自己往上抬一档
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
        chPanel = findViewById(R.id.chPanel)
        rvCh = findViewById(R.id.rvCh)
        btnCh = findViewById(R.id.btnCh)
        btnClosePanel = findViewById(R.id.btnClosePanel)
        // 手机/投影上没有遥控器按键：屏幕右上角这个「☰ 频道」就是触摸入口
        btnCh.setOnClickListener { openPanel() }
        btnClosePanel.setOnClickListener { closePanel() }
        tvEpgNow = findViewById(R.id.tvEpgNow)
        tvEpgNext = findViewById(R.id.tvEpgNext)

        // 只带 UA：直播清单会被改写成第三方源直链，把站点 token 塞进 Authorization 头
        // 会一路带给那些 CDN（不安全，有的源还因此拒播）。站点鉴权走 URL 上的 ?token=
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(Api.UA)
            .setAllowCrossProtocolRedirects(true)
            // ⚠️ ExoPlayer 默认连接/读取超时只有 8 秒，直播拉一个分片动辄十几秒
            // （实测翡翠台 14s、CCTV13 30s+），8 秒一到直接抛 Source error。
            .setConnectTimeoutMs(15000)
            .setReadTimeoutMs(30000)
            .setDefaultRequestProperties(mapOf("Accept" to "*/*"))

        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(httpFactory))
            .build()
        ready = true
        playerView.player = player
        playerView.controllerShowTimeoutMs = 5000
        playerView.setShowNextButton(false)
        playerView.setShowPreviousButton(false)

        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) {
                    pb.visibility = View.GONE
                    autoSw = 0
                    ui.removeCallbacks(watchdog)
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                ui.removeCallbacks(watchdog)
                escalate(error.message ?: "源不可用")
            }
        })

        rvCh.layoutManager = LinearLayoutManager(this)
        quickAnim(rvCh)
        val list = PlayCache.iptv
        if (list.isNotEmpty()) {
            rvCh.adapter = ChannelAdapter(list, PlayCache.iptvEpg) { pos ->
                idx = pos
                PlayCache.iptvIndex = pos
                stage = 0
                autoSw = 0
                closePanel()
                play()
            }
        }

        play()
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
    }

    override fun onPause() {
        ui.removeCallbacks(watchdog)
        super.onPause()
        if (ready) runCatching { player.pause() }
    }

    override fun onDestroy() {
        ui.removeCallbacks(watchdog)
        if (ready) runCatching { player.release() }
        ready = false
        super.onDestroy()
    }

    // ---------- 遥控器 ----------
    override fun dispatchKeyEvent(ev: KeyEvent): Boolean {
        if (ev.action == KeyEvent.ACTION_DOWN) {
            // 焦点在频道单里时，上下键归列表，只有左右/返回键归页面
            if (chPanel.visibility == View.VISIBLE && focusInPanel()) {
                when (ev.keyCode) {
                    KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_BACK -> { closePanel(); return true }
                    KeyEvent.KEYCODE_MENU -> { closePanel(); return true }
                }
                return super.dispatchKeyEvent(ev)
            }
            when (ev.keyCode) {
                KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
                    ui.postDelayed({ showVolume() }, 150)
                    return false
                }
                KeyEvent.KEYCODE_DPAD_UP -> { stepChannel(-1); return true }
                KeyEvent.KEYCODE_DPAD_DOWN -> { stepChannel(1); return true }
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_CENTER,
                KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MENU -> { openPanel(); return true }
                KeyEvent.KEYCODE_BACK -> { finish(); return true }
            }
        }
        return super.dispatchKeyEvent(ev)
    }

    private fun focusInPanel(): Boolean {
        var n: View? = currentFocus ?: return false
        while (n != null) {
            if (n === chPanel) return true
            n = n.parent as? View
        }
        return false
    }

    private fun openPanel() {
        chPanel.visibility = View.VISIBLE
        btnCh.visibility = View.GONE
        paintPanelEpg()
        // 把当前正在播的台滚到可见位置，别让用户进去还得从头翻
        if (idx >= 0) rvCh.scrollToPosition(idx)
        // 容器拿不到焦点，把焦点递给列表里的第一行，确认键才是「选台」
        rvCh.post {
            val first = rvCh.getChildAt(0)
            if (first != null) first.requestFocus() else rvCh.requestFocus()
        }
    }

    // 面板底部的节目单：跟着当前播放的台走
    private fun paintPanelEpg() {
        val e = PlayCache.iptvEpg[curCid]
        if (e?.t.isNullOrBlank()) {
            tvEpgNow.text = "节目单暂无信息"
            tvEpgNext.text = ""
            return
        }
        tvEpgNow.text = "正在播：" + e!!.t + (if (e.ce > 0) "（至 " + hhmm(e.ce) + "）" else "")
        tvEpgNext.text = if (e.next.isNullOrBlank()) ""
        else "接下来 " + (if (e.ns > 0) hhmm(e.ns) + " " else "") + e.next
    }

    private fun hhmm(ts: Long): String =
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA).format(java.util.Date(ts))

    private fun closePanel() {
        chPanel.visibility = View.GONE
        btnCh.visibility = View.VISIBLE
        playerView.requestFocus()
    }

    private fun showVolume() {
        val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val cur = am.getStreamVolume(AudioManager.STREAM_MUSIC)
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
        toast("音量 ${cur * 100 / max}%")
    }

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
        tvErr.text = "这个频道播不出来：\n$reason\n\n按左键叫出频道单手动挑一个，或稍后再试"
        tvErr.visibility = View.VISIBLE
    }

    private fun play() {
        val c = PlayCache.iptv.getOrNull(idx)
        if (c == null) { showErr("没有这个频道"); return }
        curCid = c.cid.orEmpty()
        curDirect = c.direct
        // 台名 + 正在播的节目（后台配了节目单才有）：信息量和网页版对齐
        val e = PlayCache.iptvEpg[curCid]
        tvTitle.text = c.name.orEmpty() +
            (if (!e?.t.isNullOrBlank()) "  ·  正在播：" + e!!.t else "") +
            (if (stage >= 1) "（代理）" else "")
        tvErr.visibility = View.GONE
        pb.visibility = View.VISIBLE
        if (chPanel.visibility == View.VISIBLE) paintPanelEpg()

        val url = if (stage >= 1) Api.iptvStreamPx(curCid) else Api.iptvStream(curCid)

        /* ⚠️ /api/iptv/stream?ch=xxx 这种地址没有 .m3u8 后缀。
           ExoPlayer 按 URI 后缀推断内容类型，没后缀就会被当成普通视频文件交给
           ProgressiveMediaSource 去解，拿一份文本清单去抽帧 → Source error。
           这里对非直连频道显式声明是 HLS 清单。直连频道留给 ExoPlayer 嗅探。 */
        val b = MediaItem.Builder().setUri(url)
        if (!curDirect) b.setMimeType(MimeTypes.APPLICATION_M3U8)

        runCatching { player.stop() }
        player.setMediaItem(b.build())
        player.prepare()
        player.playWhenReady = true

        ui.removeCallbacks(watchdog)
        ui.postDelayed(watchdog, 25000)
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
