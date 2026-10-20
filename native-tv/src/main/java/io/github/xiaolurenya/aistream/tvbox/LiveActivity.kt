package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
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
    private var focusCid = ""   // v1.4.17：选台面板里焦点所在的台（没确认播放也算，顶部节目单跟着它走）

    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var pb: ProgressBar
    private lateinit var tvTitle: TextView
    private lateinit var tvErr: TextView
    private lateinit var chPanel: View
    private lateinit var rvCh: RecyclerView
    private lateinit var btnClosePanel: TextView
    private lateinit var tvEpgNow: MarqueeTextView
    private lateinit var tvEpgNext: MarqueeTextView
    // （v1.4.14 起 MarqueeTextView 自带跑马灯调度，不再需要独立的 MarqueeLabel 控制器）

    // 频道单：分类筛选（分组从直播源自带数据来）+ 台名搜索
    private lateinit var etSearch: EditText
    private lateinit var llCats: LinearLayout
    private lateinit var chAdapter: ChannelAdapter   // 复用同一个 adapter，搜索时只换数据不重建
    private var cats = listOf<Pair<String, Int>>()   // (分组名, 频道数)，后台什么列表就是什么列表，默认选中第一组
    private var selCat = 0
    private var query = ""
    private var shown: List<Api.IptvCh> = emptyList()
    private val ui = Handler(Looper.getMainLooper())

    // 看门狗：有些源握手成功后就挂在那儿不动，既不报错也不出画面，到点就自己往上抬一档
    private val watchdog = object : Runnable {
        override fun run() {
            if (!ready) return
            val st = player.playbackState
            if (st == Player.STATE_BUFFERING || st == Player.STATE_IDLE) escalate("连接超时")
        }
    }

    /* v1.4.17 节目单「时时自动更新」：EPG 只在进直播时拉一次，播到 19:33 节目换了
       面板顶部还挂着「正在播 新闻联播（至 19:33）」—— 大哥点名不会实时识别。
       每 60s 后台重拉一次 /api/iptv（节目单跟频道列表同一接口，包很小），有变化才
       刷 PlayCache + adapter（行内节目单）+ 面板顶部；面板开着还跟焦点台实时走。 */
    private val epgTick = object : Runnable {
        override fun run() {
            ui.postDelayed(this, 60000L)
            Thread {
                val r = runCatching { Api.iptv() }.getOrNull() ?: return@Thread
                ui.post {
                    val now = r.now.orEmpty()
                    if (now != PlayCache.iptvEpg) {
                        PlayCache.iptvEpg = now
                        if (::chAdapter.isInitialized) chAdapter.updateEpg(now)
                        // 面板开着时优先显示焦点台的节目单，别把焦点台顶掉
                        if (chPanel.visibility == View.VISIBLE)
                            paintPanelEpg(if (focusCid.isNotBlank()) focusCid else curCid)
                    }
                }
            }.start()
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
        btnClosePanel = findViewById(R.id.btnClosePanel)
        bindFocus(btnClosePanel)   // 关闭按钮要有放大描边反馈，遥控器才知道选没选中
        btnClosePanel.setOnClickListener { closePanel() }
        tvEpgNow = findViewById(R.id.tvEpgNow)
        tvEpgNext = findViewById(R.id.tvEpgNext)
        // v1.4.14：MarqueeTextView 自带跑马灯（自绘裁剪），无需再包控制器

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

        // 触摸：点屏幕左半边 = 呼出频道单（手机/投影没遥控器，这是主要入口）；右半边 = 控制条
        playerView.setOnTouchListener { v, ev ->
            if (ev.action == MotionEvent.ACTION_UP) {
                if (ev.x < v.width / 2f) openPanel() else playerView.showController()
            }
            true
        }

        rvCh.layoutManager = LinearLayoutManager(this)
        // 选台列表要的是遥控器一按立刻换高亮：任何 item 动画都是拖沓
        noAnim(rvCh)
        chAdapter = ChannelAdapter(
            emptyList(), PlayCache.iptvEpg,
            // v1.4.17：焦点挪到哪个台（没按确认播放也一样），顶部节目单立刻换成那个台的
            onFocused = { focusCid = it; paintPanelEpg(it) }
        ) { pos -> pickShown(pos) }
        rvCh.adapter = chAdapter
        // v1.4.17：节目单每 60s 重拉一次，正在播/接下来到点自动换，不再进直播时定格
        ui.postDelayed(epgTick, 60000L)
        etSearch = findViewById(R.id.etSearch)
        bindFocus(etSearch)
        llCats = findViewById(R.id.llCats)
        etSearch.addTextChangedListener(object : android.text.TextWatcher {
            override fun onTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {
                query = s?.toString().orEmpty().trim()
                applyFilter()
            }
            override fun beforeTextChanged(s: CharSequence?, st: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: android.text.Editable?) {}
        })
        buildCats()

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
        ui.removeCallbacks(epgTick)
        runCatching { tvEpgNow.stopMarquee() }
        runCatching { tvEpgNext.stopMarquee() }
        if (ready) runCatching { player.release() }
        ready = false
        super.onDestroy()
    }

    // ---------- 遥控器 ----------
    override fun dispatchKeyEvent(ev: KeyEvent): Boolean {
        if (ev.action == KeyEvent.ACTION_DOWN) {
            // 面板开着：返回 / 菜单键收面板；其余按键全部交回系统，
            // 让焦点在「搜索框 ↔ 分组列 ↔ 频道列表」之间正常走（参照样式的两栏导航）
            if (chPanel.visibility == View.VISIBLE) {
                when (ev.keyCode) {
                    KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_MENU -> { closePanel(); return true }
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

    // ---------- 分组筛选（竖列） + 搜索 ----------
    /* 参照样式：左边一列分组（后台 groupOrder 优先，没配到的按出现顺序补后面），
       不再放「全部」——后台是什么列表就是什么列表，进来默认选中第一组。 */
    private fun buildCats() {
        val all = PlayCache.iptv
        val counts = LinkedHashMap<String, Int>()
        for (c in all) {
            val g = c.group.orEmpty().ifBlank { "其他" }
            counts[g] = (counts[g] ?: 0) + 1
        }
        val ordered = LinkedHashMap<String, Int>()
        for (g in PlayCache.iptvGroupOrder) {
            val n = counts.remove(g) ?: continue
            ordered[g] = n
        }
        ordered.putAll(counts)
        cats = ordered.map { Pair(it.key, it.value) }
        selCat = 0
        paintCats()
        applyFilter()
    }

    private fun paintCats() {
        if (cats.isEmpty()) return
        llCats.removeAllViews()
        val dm = resources.displayMetrics.density
        cats.forEachIndexed { i, (name, _) ->
            val tv = TextView(this)
            tv.text = name
            tv.gravity = android.view.Gravity.CENTER
            tv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f)
            tv.setTextColor(getColor(if (i == selCat) R.color.fg else R.color.fg_dim))
            tv.setBackgroundResource(if (i == selCat) R.drawable.bg_cat_on else R.drawable.bg_cat)
            tv.isFocusable = true
            tv.isFocusableInTouchMode = true
            tv.setPadding(0, (11 * dm).toInt(), 0, (11 * dm).toInt())
            tv.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = (8 * dm).toInt() }
            tv.setOnClickListener { selCat = i; paintCats(); applyFilter() }
            bindFocus(tv)
            llCats.addView(tv)
        }
    }

    private fun applyFilter() {
        val all = PlayCache.iptv
        if (all.isEmpty()) return
        var list = if (selCat in cats.indices)
            all.filter { it.group.orEmpty().ifBlank { "其他" } == cats[selCat].first }
        else all
        if (query.isNotBlank()) list = list.filter { it.name.orEmpty().contains(query, ignoreCase = true) }
        shown = list
        val curCid = PlayCache.iptv.getOrNull(PlayCache.iptvIndex)?.cid.orEmpty()
        // 只换数据不重建 adapter：搜索每敲一个字都全量重建的话，遥控器上敲字能卡出残影
        chAdapter.submit(list, curCid)
        // 不再抢焦点：点完分组焦点留在分组列，大哥自己决定继续换组还是右键进频道列表
    }

    // 频道列表里按确认：拿 cid 映射回全量索引，筛选状态下选台不会错位
    private fun pickShown(pos: Int) {
        val all = PlayCache.iptv
        val cid = shown.getOrNull(pos)?.cid.orEmpty()
        val gi = all.indexOfFirst { it.cid == cid }
        if (gi < 0) return
        idx = gi
        PlayCache.iptvIndex = gi
        stage = 0
        autoSw = 0
        closePanel()
        play()
    }

    private fun openPanel() {
        chPanel.visibility = View.VISIBLE
        tvTitle.visibility = View.GONE      // 面板盖住左半边，藏掉顶部台名，免得透出来跟面板叠字
        paintCats()
        paintPanelEpg()
        // 把当前正在播的台滚到可见位置，别让用户进去还得从头翻。
        // 注意要用「筛选后列表里的位置」：直接拿全量 idx 在筛选状态下会滚错行
        val pos = shown.indexOfFirst { it.cid == curCid }
        rvCh.scrollToPosition(if (pos >= 0) pos else 0)
        // 容器拿不到焦点，把焦点递给列表里的第一行，确认键才是「选台」
        rvCh.post {
            val first = rvCh.getChildAt(0)
            if (first != null) first.requestFocus() else rvCh.requestFocus()
        }
    }

    // 面板标题下的节目单：默认跟当前播放的台走；v1.4.17 起焦点在列表里挪动（未确认
    // 播放也一样）时由 ChannelAdapter.onFocused 传焦点台 cid 进来，实时更新识别 ——
    // 不再只认正在播的台（v1.4.14 起 MarqueeTextView 自带跑马灯）
    private fun paintPanelEpg(cid: String = curCid) {
        val e = PlayCache.iptvEpg[cid]
        if (e?.t.isNullOrBlank()) {
            // 直接 setText 会自动停跑马灯（MarqueeTextView.setText override）
            tvEpgNow.text = "节目单暂无信息"
            tvEpgNext.text = ""
            return
        }
        tvEpgNow.bindMarquee("正在播：" + e!!.t + (if (e.ce > 0) "（至 " + hhmm(e.ce) + "）" else ""))
        tvEpgNext.bindMarquee(
            if (e.next.isNullOrBlank()) ""
            else "接下来 " + (if (e.ns > 0) hhmm(e.ns) + " " else "") + e.next
        )
    }

    private fun hhmm(ts: Long): String =
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA).format(java.util.Date(ts))

    private fun closePanel() {
        chPanel.visibility = View.GONE
        focusCid = ""   // v1.4.17：面板收了就清焦点台，下次打开回到「正在播的台」
        tvTitle.visibility = View.VISIBLE   // 面板收起，台名恢复显示
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
        /* 全屏直播永远有声：MeFragment 那个「直播小窗静音」开关只管首页的直播小窗
           （Prefs.iptvMute 只有 HomeFragment 的小窗播放器读）。
           以前这里跟着读这个开关 → 小窗静音后进全屏也没声音，用户点名要修 */
        player.volume = 1f
        player.playWhenReady = true

        ui.removeCallbacks(watchdog)
        ui.postDelayed(watchdog, 25000)
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
