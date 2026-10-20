package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 首页（图1 样式）：左侧功能卡列 + 中间大海报 hero + 右侧推荐列，下面按栏目一行行竖着排。
   hero 支持直播预览小窗：焦点落在「电视直播」卡上就小窗播当前台（带防抖，快速滑过不误播），
   确认键进全屏直播页，焦点移开就停掉预览、恢复海报。hero 用海报原图 + 渐变压暗，不做模糊。 */
class HomeFragment : Fragment(R.layout.fragment_home) {

    private lateinit var adapter: ColumnAdapter
    private lateinit var rvTabs: RecyclerView
    private lateinit var rv: RecyclerView
    private lateinit var hero: View
    private lateinit var heroBg: ImageView
    private lateinit var heroText: View
    private lateinit var heroTitle: TextView
    private lateinit var heroMeta: TextView
    private lateinit var dots: LinearLayout
    private lateinit var heroPv: PlayerView
    private lateinit var liveInfo: View
    private lateinit var tvLiveName: TextView
    private lateinit var tvLiveEpg: TextView

    private val ui = Handler(Looper.getMainLooper())
    private var picks = listOf<Api.Card>()
    private var cur = 0
    private var tabIdx = 0          // 顶部分类栏当前选中（0 = 首页）
    private var homeCols = listOf<Api.Column>()

    // 右侧推荐列轮播（图3 参考：自动轮换最新海报）：取首页第一栏全部卡片做池子，
    // 定时滚动一个 N 张的窗口；用户在侧栏里聚焦浏览时暂停轮播，不抢焦点
    private var sidePool = listOf<Api.Card>()
    private var sideOff = 0
    private var rvSide: RecyclerView? = null

    // 直播预览小窗
    private var pvPlayer: ExoPlayer? = null
    private var previewOn = false
    private var pvStage = 0            // 0 直连 → 1 服务端代理（跟直播页同一套兜底）
    private var pvCid = ""
    private var pvDirect = false
    private var iptvLoaded = false

    private val startPreviewDebounced = Runnable { startPreview() }

    // 预览看门狗：卡在缓冲就静默换代理档，再不行就放弃（预览不打扰用户）
    private val pvWatchdog = object : Runnable {
        override fun run() {
            val p = pvPlayer ?: return
            val st = p.playbackState
            if (st == Player.STATE_BUFFERING || st == Player.STATE_IDLE) {
                if (pvStage < 1) { pvStage = 1; pvPlay() }
            }
        }
    }

    // 只在页面可见时轮换，退后台就停，别在后台白耗电
    private val rot = object : Runnable {
        override fun run() {
            runCatching {
                if (picks.size > 1 && !previewOn) {
                    cur = (cur + 1) % picks.size
                    paintHero()
                }
            }.onFailure { Log.w("aistream", "hero next: " + it.message) }
            ui.postDelayed(this, ROT_MS)
        }
    }

    // 右侧推荐列轮播：池子比窗口大才需要转；用户在侧栏聚焦浏览时跳过这一拍。
    // 预览小窗开着时也跳过：弱性能盒子/投影上视频解码 + 换图解码同时跑，遥控器都卡（大哥图2）
    private val rotSide = object : Runnable {
        override fun run() {
            runCatching {
                val n = resources.getInteger(R.integer.side_max)
                if (sidePool.size > n && !previewOn && rvSide?.hasFocus() != true) {
                    sideOff = (sideOff + 1) % sidePool.size
                    sideAdapter.submit(sideWindow(n))
                }
            }.onFailure { Log.w("aistream", "side rot: " + it.message) }
            ui.postDelayed(this, SIDE_MS)
        }
    }

    // 从 sidePool 里取以 sideOff 起、长度为 n 的循环窗口（不够一圈就绕回来）
    private fun sideWindow(n: Int): List<Api.Card> {
        val out = mutableListOf<Api.Card>()
        for (k in 0 until n) out.add(sidePool[(sideOff + k) % sidePool.size])
        return out
    }

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        hero = v.findViewById(R.id.hero)
        heroBg = v.findViewById(R.id.heroBg)
        heroText = v.findViewById(R.id.heroText)
        heroTitle = v.findViewById(R.id.heroTitle)
        heroMeta = v.findViewById(R.id.heroMeta)
        dots = v.findViewById(R.id.heroDots)
        heroPv = v.findViewById(R.id.heroPv)
        liveInfo = v.findViewById(R.id.liveInfo)
        tvLiveName = v.findViewById(R.id.tvLiveName)
        tvLiveEpg = v.findViewById(R.id.tvLiveEpg)
        rv = v.findViewById(R.id.recycler)
        rv.layoutManager = LinearLayoutManager(requireContext())
        quickAnim(rv)
        adapter = ColumnAdapter(
            onClick = { c -> openDetail(c) },
            loadMore = { serverIdx, page, onResult ->
                // 每行横向滑到末尾拉下一页；结果回主线程交给 adapter 追加
                viewLifecycleOwner.lifecycleScope.launch {
                    val more = withContext(Dispatchers.IO) {
                        runCatching { Api.homeMore(serverIdx, page) }.getOrDefault(emptyList())
                    }
                    withContext(Dispatchers.Main) { onResult(more) }
                }
            },
            // 栏目标题被选中：弹出该栏目满屏海报墙（对应顶部分类标签同一个入口）
            onOpenCol = { serverIdx -> CategoryActivity.open(requireContext(), serverIdx) }
        )
        rv.adapter = adapter

        // 顶部分类标签栏（图1 样式）：点了滚到对应栏目行
        rvTabs = v.findViewById(R.id.rvTabs)
        rvTabs.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        noAnim(rvTabs)

        // 栏目行往上滚的时候，顶部分类栏高亮跟着走（滑到哪行亮哪个）
        rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                val lm = recyclerView.layoutManager as? LinearLayoutManager ?: return
                val first = lm.findFirstCompletelyVisibleItemPosition()
                if (first < 0) return
                if (first in homeCols.indices && first + 1 != tabIdx) {
                    tabIdx = first + 1
                    rvTabs.adapter?.notifyDataSetChanged()
                }
            }
        })

        val btnPlay = v.findViewById<TextView>(R.id.btnPlay)
        bindFocus(btnPlay)
        btnPlay.setOnClickListener {
            picks.getOrNull(cur)?.let { openDetail(it) }
        }

        // 右侧推荐列：取服务器首页第一栏最前面几张海报
        rvSide = v.findViewById<RecyclerView>(R.id.rvSide)
        rvSide!!.layoutManager = LinearLayoutManager(requireContext())
        noAnim(rvSide!!)
        rvSide!!.adapter = sideAdapter

        load()
        loadIptv()
    }

    private val sideAdapter = object : RecyclerView.Adapter<PosterAdapter.H>() {
        val items = mutableListOf<Api.Card>()
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PosterAdapter.H =
            PosterAdapter.H(
                // 右侧推荐列用扁横卡（小图左 + 片名右，参考 base.apk），ID 跟 item_poster 一致
                LayoutInflater.from(parent.context).inflate(R.layout.item_side_flat, parent, false)
            )
        override fun getItemCount() = items.size
        override fun onBindViewHolder(h: PosterAdapter.H, i: Int) {
            val c = items[i]
            h.title.text = c.title.orEmpty()
            h.sub.text = ""
            h.badge.visibility = View.GONE
            val u = Api.dimg(c.poster)
            if (u.isBlank()) h.img.setImageDrawable(null) else h.img.load(u)
            // v1.4.17：放大是描边「错位/靠右」的根源（1.06 出界、1.03 四周仍悬空一圈，
            // 大哥还是不满意）→ 侧栏卡干脆**不放大只描边**：圆角已与 bg_card 对齐的
            // 2dp 白框紧贴卡片轮廓，看着就是「框在卡上」，绝无错位、绝无过界
            bindFocus(h.card, 1f)
            h.itemView.setOnClickListener { openDetail(c) }
        }
        fun submit(list: List<Api.Card>) {
            items.clear(); items.addAll(list); notifyDataSetChanged()
        }
    }

    override fun onResume() {
        super.onResume()
        ui.removeCallbacks(rot)
        ui.postDelayed(rot, ROT_MS)
        // 右侧推荐列轮播：页面可见才转
        ui.removeCallbacks(rotSide)
        ui.postDelayed(rotSide, SIDE_MS)
        // 从详情页/播放器返回：设置开了「首页直接播直播」就恢复小窗
        // （loadIptv 提前 return 那条分支不会触发 startPreview，这里补上）
        if (Prefs.heroLive && PlayCache.iptv.isNotEmpty() && !previewOn) startPreview()
    }

    override fun onPause() {
        ui.removeCallbacks(rot)
        ui.removeCallbacks(rotSide)
        ui.removeCallbacks(startPreviewDebounced)
        stopPreview()
        super.onPause()
    }

    override fun onDestroyView() {
        ui.removeCallbacks(rot)
        ui.removeCallbacks(rotSide)
        ui.removeCallbacks(startPreviewDebounced)
        ui.removeCallbacks(pvWatchdog)
        stopPreview()
        pvPlayer?.release()
        pvPlayer = null
        super.onDestroyView()
    }

    private fun openDetail(c: Api.Card) {
        DetailActivity.open(requireContext(), c)
    }

    /* 首页加载：先吃本地缓存秒开（上次拉好的整页），网络回来再刷新一遍。
       新安装首次没有缓存走纯网络；下次打开海报栏瞬间就在，不再干等。 */
    private fun load() {
        viewLifecycleOwner.lifecycleScope.launch {
            val cached = withContext(Dispatchers.IO) { readHomeCache() }
            if (cached.isNotEmpty()) renderHome(cached)

            val fresh = withContext(Dispatchers.IO) {
                runCatching { Api.home() }.getOrNull()
            }
            val cols = fresh?.columns.orEmpty()
            if (cols.isNotEmpty()) {
                renderHome(cols)
                withContext(Dispatchers.IO) { writeHomeCache(fresh!!) }
            }
        }
    }

    private fun renderHome(cols: List<Api.Column>) {
        // 空栏目不占位：配了采集站但没内容时首页不该出现一堆空标题
        val keep = cols.filter { !it.items.isNullOrEmpty() }
        homeCols = keep
        // 供顶部分类标签点进来弹该栏目的海报网格复用（不需要再请求一次首页）
        PlayCache.homeCols = keep
        adapter.submit(keep)
        paintTabs()

        picks = pickBanner(keep)
        if (picks.isEmpty()) {
            hero.visibility = View.GONE
        } else {
            hero.visibility = View.VISIBLE
            cur = 0
            paintHero()
        }
        // 右侧推荐列：用首页第一栏全部卡片做轮播池（窗口张数按屏幕分档），自动轮换最新
        val sm = resources.getInteger(R.integer.side_max)
        sidePool = keep.firstOrNull()?.items.orEmpty()
        sideOff = 0
        sideAdapter.submit(sideWindow(sm))
    }

    // 缓存文件按服务器地址区分（换站点不会吃到别人家的首页）
    private fun homeCacheFile() = java.io.File(
        requireContext().cacheDir,
        "home_" + Integer.toHexString(Prefs.base.hashCode()) + ".json"
    )

    private fun readHomeCache(): List<Api.Column> = try {
        val f = homeCacheFile()
        if (!f.exists()) emptyList()
        else Api.homeFromJson(f.readText())?.columns.orEmpty().filter { !it.items.isNullOrEmpty() }
    } catch (e: Exception) { emptyList() }

    private fun writeHomeCache(h: Api.Home) = try {
        homeCacheFile().writeText(Api.homeToJson(h))
    } catch (e: Exception) { }

    /* 频道数据提前拉好：预览小窗和全屏直播页都用 PlayCache.iptv 这一份。
       已加载过就不再拉（30 秒内回来不用重新等）。 */
    private fun loadIptv() {
        if (iptvLoaded || PlayCache.iptv.isNotEmpty()) {
            iptvLoaded = true
            return
        }
        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { Api.iptv() }.getOrNull()
            }
            val list = r?.channels.orEmpty()
            if (list.isNotEmpty()) {
                PlayCache.iptv = list
                PlayCache.iptvEpg = r?.now.orEmpty()
                PlayCache.iptvGroupOrder = r?.groupOrder.orEmpty()
            }
            iptvLoaded = true
            // 设置里开了「首页直接播直播」：频道一到就播，不等焦点
            if (Prefs.heroLive && PlayCache.iptv.isNotEmpty() && !previewOn) startPreview()
        }
    }

    /* 顶部分类栏：「首页」+ 各栏目名。
       点「首页」回顶；点某个栏目 = 弹出该栏目的海报网格（对应界面到前面），挑一张进详情。 */
    private fun paintTabs() {
        val names = listOf("首页") + homeCols.map { it.label.orEmpty().ifBlank { "栏目" } }
        rvTabs.adapter = ChipAdapter(names, { tabIdx }, wrap = true) { i ->
            tabIdx = i
            if (i == 0) rv.smoothScrollToPosition(0)
            else {
                val idx = (i - 1).coerceIn(0, (homeCols.size - 1).coerceAtLeast(0))
                // 传服务端栏目序号给分类页翻页（首页过滤过空栏目，客户端下标已错位）
                val serverIdx = homeCols.getOrNull(idx)?.idx ?: idx
                CategoryActivity.open(requireContext(), serverIdx)
            }
        }
    }

    /* hero 的候选：严格按服务器首页返回的栏目顺序取（第一栏最优先），
       按「片名+年份」去重，没海报的不要。服务端首页配了什么、排什么顺序，
       TV 就照着来，不做任何本地重排 —— 每个人看到的都是他自己首页最靠前的推荐。 */
    private fun pickBanner(cols: List<Api.Column>): List<Api.Card> {
        val seen = HashSet<String>()
        val out = mutableListOf<Api.Card>()
        for (col in cols) {
            for (c in col.items.orEmpty()) {
                val key = c.title.orEmpty().trim() + "|" + c.year.orEmpty().trim()
                if (!seen.add(key)) continue
                if (Api.dimg(c.poster).isBlank()) continue
                out.add(c)
                if (out.size >= HERO_MAX) return out
            }
        }
        return out
    }

    private fun paintHero() {
        val c = picks.getOrNull(cur) ?: return
        heroTitle.text = c.title.orEmpty()
        val bits = mutableListOf<String>()
        if (!c.year.isNullOrBlank()) bits.add(c.year!!)
        if (!c.station.isNullOrBlank()) bits.add(c.station!!)
        val sc = c.score.orEmpty().toDoubleOrNull()
        if (sc != null && sc > 0) bits.add("%.1f".format(sc))
        heroMeta.text = bits.joinToString(" · ")

        val u = Api.dimg(c.poster)
        if (u.isNotBlank()) heroBg.load(u)
        paintDots()
    }

    // 右下角小圆点：当前那条拉长成小横条
    private fun paintDots() {
        dots.removeAllViews()
        val n = picks.size
        if (n <= 1) return
        val ctx = dots.context
        val dm = ctx.resources.displayMetrics.density
        for (k in 0 until n) {
            val d = View(ctx)
            val w = ((if (k == cur) 18 else 7) * dm).toInt()
            val lp = LinearLayout.LayoutParams(w, (7 * dm).toInt())
            lp.marginEnd = (6 * dm).toInt()
            d.layoutParams = lp
            d.setBackgroundResource(if (k == cur) R.drawable.dot_on else R.drawable.dot_off)
            dots.addView(d)
        }
    }

    /* 导航轨「电视直播」卡聚焦/失焦的转发入口（卡已上提到 MainActivity）。
       聚焦出小窗预览，失焦收起来。 */
    fun onLiveFocus(has: Boolean) {
        if (has) schedulePreview() else stopPreview()
    }

    // 预览小窗是否开着（MainActivity 按返回键时判断：开着先收小窗，别直接退应用）
    fun previewShowing() = previewOn

    // ---------- 直播预览小窗 ----------
    private fun schedulePreview() {
        // 防抖：遥控器连着滑过别的卡，500ms 后还停在直播卡上才开播
        ui.removeCallbacks(startPreviewDebounced)
        ui.postDelayed(startPreviewDebounced, 500)
    }

    private fun startPreview() {
        val c = PlayCache.iptv.getOrNull(PlayCache.iptvIndex) ?: return
        if (previewOn && pvCid == c.cid.orEmpty()) return
        previewOn = true
        pvStage = 0
        pvCid = c.cid.orEmpty()
        pvDirect = c.direct

        heroBg.visibility = View.GONE
        heroText.visibility = View.GONE
        dots.visibility = View.GONE
        heroPv.visibility = View.VISIBLE
        liveInfo.visibility = View.VISIBLE
        tvLiveName.text = c.name.orEmpty()
        val e = PlayCache.iptvEpg[pvCid]
        tvLiveEpg.text = if (e?.t.isNullOrBlank()) "节目单暂无信息" else "正在播：" + e!!.t

        pvPlay()
        // 点预览画面直接进全屏直播。用 OnTouchListener 而不是 OnClickListener：
        // PlayerView 自己会消费触摸事件（useController=false 时也 return true），
        // OnClickListener 根本收不到 ACTION_UP。
        // ⚠️ 必须只认 ACTION_UP：之前所有触摸事件都调 openLiveFull，一次点按
        // DOWN/MOVE/UP 连开好几个 LiveActivity 叠着，每个都在出声 —— 大哥说的
        // 「小画面放大后大小画面声音串了」就是这个。
        heroPv.setOnTouchListener { v, ev ->
            if (ev.action == android.view.MotionEvent.ACTION_UP) openLiveFull()
            true
        }
        // 遥控器也要能选中小窗、按 OK 放大进全屏（之前小窗拿不到焦点，遥控器点不中）
        heroPv.isFocusable = true
        heroPv.isFocusableInTouchMode = true
        bindFocus(heroPv)
        heroPv.setOnKeyListener { _, k, ev ->
            if (ev.action == android.view.KeyEvent.ACTION_DOWN &&
                (k == android.view.KeyEvent.KEYCODE_DPAD_CENTER || k == android.view.KeyEvent.KEYCODE_ENTER)
            ) {
                openLiveFull()
                true
            } else false
        }
    }

    private var lastLiveOpen = 0L

    private fun openLiveFull() {
        // 双保险：1.2 秒内重复触发直接忽略（误触/连点不会再叠出多个直播页）
        val n = android.os.SystemClock.elapsedRealtime()
        if (n - lastLiveOpen < 1200) return
        lastLiveOpen = n
        stopPreview()
        startActivity(Intent(requireContext(), LiveActivity::class.java))
    }

    private fun stopPreview() {
        ui.removeCallbacks(startPreviewDebounced)
        if (!previewOn) return
        previewOn = false
        ui.removeCallbacks(pvWatchdog)
        runCatching { pvPlayer?.stop() }
        heroBg.visibility = View.VISIBLE
        heroText.visibility = View.VISIBLE
        dots.visibility = View.VISIBLE
        heroPv.visibility = View.GONE
        liveInfo.visibility = View.GONE
    }

    private fun pvPlay() {
        val p = pvPlayer ?: ExoPlayer.Builder(requireContext())
            .setMediaSourceFactory(DefaultMediaSourceFactory(
                DefaultHttpDataSource.Factory()
                    .setUserAgent(Api.UA)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(30000)
                    .setDefaultRequestProperties(mapOf("Accept" to "*/*"))
            ))
            .build().also {
                pvPlayer = it
                heroPv.player = it
                // 小窗预览不要控制条（会挡住画面）。
                // 比例用 ZOOM 等比铺满容器：投影/电视上 hero 容器普遍比 16:9 宽，
                // 之前 FIT 会在左右留两条黑边/暗底（大哥图1「左右还有很多没显示画面」），
                // 铺满只等比裁掉上下一点点，画面永远填满整个小窗。
                heroPv.useController = false
                heroPv.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                it.addListener(object : Player.Listener {
                    override fun onPlaybackStateChanged(state: Int) {
                        if (state == Player.STATE_READY) ui.removeCallbacks(pvWatchdog)
                    }
                    override fun onPlayerError(error: PlaybackException) {
                        ui.removeCallbacks(pvWatchdog)
                        if (pvStage < 1) { pvStage = 1; pvPlay() }
                        else tvLiveEpg.text = "这个频道暂时预览不了，进全屏试试"
                    }
                })
            }
        val url = if (pvStage >= 1) Api.iptvStreamPx(pvCid) else Api.iptvStream(pvCid)
        val b = MediaItem.Builder().setUri(url)
        // 跟直播页同一个坑：/api/iptv/stream 没 .m3u8 后缀，必须显式声明 HLS
        if (!pvDirect) b.setMimeType(MimeTypes.APPLICATION_M3U8)
        // 直播小窗静音开关（设置里控制）：直接调播放器音量，0 = 静音
        p.volume = if (Prefs.iptvMute) 0f else 1f
        runCatching { p.stop() }
        p.setMediaItem(b.build())
        p.prepare()
        p.playWhenReady = true
        ui.removeCallbacks(pvWatchdog)
        ui.postDelayed(pvWatchdog, 20000)
    }

    private companion object {
        const val ROT_MS = 6000L   // hero 轮换间隔
        const val HERO_MAX = 6     // 最多轮换几条
        const val SIDE_MS = 5000L  // 右侧推荐列轮播间隔
    }
}
