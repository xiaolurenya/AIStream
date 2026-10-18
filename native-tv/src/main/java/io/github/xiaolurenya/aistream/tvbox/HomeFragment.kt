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
        adapter = ColumnAdapter { c -> openDetail(c) }
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
        bindFocus(btnPlay) { has -> btnPlay.alpha = if (has) 1f else 0.92f }
        btnPlay.setOnClickListener {
            picks.getOrNull(cur)?.let { openDetail(it) }
        }

        // 右侧推荐列：取服务器首页第一栏最前面几张海报
        val rvSide = v.findViewById<RecyclerView>(R.id.rvSide)
        rvSide.layoutManager = LinearLayoutManager(requireContext())
        noAnim(rvSide)
        rvSide.adapter = sideAdapter

        load()
        loadIptv()
    }

    private val sideAdapter = object : RecyclerView.Adapter<PosterAdapter.H>() {
        val items = mutableListOf<Api.Card>()
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PosterAdapter.H =
            PosterAdapter.H(
                LayoutInflater.from(parent.context).inflate(R.layout.item_poster, parent, false)
            )
        override fun getItemCount() = items.size
        override fun onBindViewHolder(h: PosterAdapter.H, i: Int) {
            val c = items[i]
            h.title.text = c.title.orEmpty()
            h.sub.text = ""
            h.badge.visibility = View.GONE
            val u = Api.dimg(c.poster)
            if (u.isBlank()) h.img.setImageDrawable(null) else h.img.load(u)
            bindFocus(h.card) { has ->
                h.card.setBackgroundResource(if (has) R.drawable.bg_focus else 0)
            }
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
        // 从详情页/播放器返回：设置开了「首页直接播直播」就恢复小窗
        // （loadIptv 提前 return 那条分支不会触发 startPreview，这里补上）
        if (Prefs.heroLive && PlayCache.iptv.isNotEmpty() && !previewOn) startPreview()
    }

    override fun onPause() {
        ui.removeCallbacks(rot)
        ui.removeCallbacks(startPreviewDebounced)
        stopPreview()
        super.onPause()
    }

    override fun onDestroyView() {
        ui.removeCallbacks(rot)
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

    private fun load() {
        viewLifecycleOwner.lifecycleScope.launch {
            val cols = withContext(Dispatchers.IO) {
                runCatching { Api.home()?.columns.orEmpty() }.getOrDefault(emptyList())
            }
            // 空栏目不占位：配了采集站但没内容时首页不该出现一堆空标题
            val keep = cols.filter { !it.items.isNullOrEmpty() }
            homeCols = keep
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
            // 右侧推荐列：第一栏最前面几张（张数按屏幕分档，手机少放两张）
            sideAdapter.submit(keep.firstOrNull()?.items.orEmpty()
                .take(resources.getInteger(R.integer.side_max)))
        }
    }

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
            }
            iptvLoaded = true
            // 设置里开了「首页直接播直播」：频道一到就播，不等焦点
            if (Prefs.heroLive && PlayCache.iptv.isNotEmpty() && !previewOn) startPreview()
        }
    }

    /* 顶部分类栏：「首页」+ 各栏目名。点栏目滚到那一行，点首页回顶。 */
    private fun paintTabs() {
        val names = listOf("首页") + homeCols.map { it.label.orEmpty().ifBlank { "栏目" } }
        rvTabs.adapter = ChipAdapter(names, { tabIdx }, wrap = true) { i ->
            tabIdx = i
            if (i == 0) rv.smoothScrollToPosition(0)
            else {
                val pos = (i - 1).coerceIn(0, (homeCols.size - 1).coerceAtLeast(0))
                rv.smoothScrollToPosition(pos)
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
        heroPv.setOnTouchListener { _, _ -> openLiveFull(); true }
    }

    private fun openLiveFull() {
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
                // 小窗预览不要控制条（会挡住画面），比例 FIT 不拉伸
                heroPv.useController = false
                heroPv.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
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
    }
}
