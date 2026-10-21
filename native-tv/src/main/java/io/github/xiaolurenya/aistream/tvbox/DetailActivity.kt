package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.SpannableStringBuilder
import android.text.Spannable
import android.text.style.ForegroundColorSpan
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* v75：详情页重做（截图样式：全屏剧照背景 + 左侧信息列 + 绿色播放大按钮 + 简介 + 演员圆头像）。
   信息页秒开：卡片数据（TMDB/豆瓣/采集）先画上去，TMDB 详情（类型/简介/演员）异步补，
   播放线路后台两路并发拉（官方上游 + 采集聚合）—— 只有获到播放线路的媒体信息，
   播放大按钮才点亮可播。不再有全屏遮罩干等，用户进来先看剧照和简介。 */
class DetailActivity : AppCompatActivity() {

    companion object {
        fun open(ctx: Context, c: Api.Card) {
            val i = Intent(ctx, DetailActivity::class.java)
            i.putExtra("title", c.title.orEmpty())
            i.putExtra("year", c.year.orEmpty())
            i.putExtra("poster", c.poster.orEmpty())
            i.putExtra("backdrop", c.backdrop.orEmpty())
            i.putExtra("score", c.score.orEmpty())
            i.putExtra("media", c.media.orEmpty())
            i.putExtra("id", c.id.orEmpty())
            i.putExtra("sid", c.station.orEmpty())
            i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            ctx.startActivity(i)
        }

        /* 详情页线路缓存：同一部片第二次进直接用缓存渲染（不挡屏），线路后台静默刷新。
           LRU 只留最近 12 部、10 分钟内有效，进程重启自然清空。 */
        private class CacheEntry(
            val up: UpReady?, val col: CollectReady?, val t: Long = System.currentTimeMillis()
        )
        private val detailCache = object : LinkedHashMap<String, CacheEntry>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CacheEntry>): Boolean = size > 12
        }
        private const val CACHE_TTL = 10 * 60 * 1000L

        /* 线路兜底超时：两路都没回来就到点用手里有的（信息页一直在，用户先看简介）。
           上游检索/解析动辄几十秒，30s 要能覆盖慢网，又不至于让用户干等太久。 */
        private const val SETTLE_TIMEOUT = 30000L
    }

    /* 两路结果先各存各的：官方（upReady）优先，采集（collectReady）兜底。
       谁先回来先存，等「有一路到位 / 到点 / 全失败」再一次性渲染线路区。 */
    private class UpReady(
        val eps: List<Api.UpEp>,
        val upLines: List<Api.UpLine>,
        val title: String,
        val year: String,
        val itemId: String,
        val kind: String,
        val poster: String,
        val plot: String
    )

    private class CollectReady(
        val lines: List<PlayCache.Line>,
        val parses: List<Api.Parse>,
        val title: String,
        val year: String,
        val itemId: String,
        val poster: String,
        val headName: String,
        val score: String,
        val meta: String,
        val plot: String
    )

    private var upReady: UpReady? = null
    private var collectReady: CollectReady? = null
    private var upDone = false
    private var collectDone = false
    private var settled = false
    private var expired = false
    private val settleLock = Any()
    private var enriched = false          // TMDB 详情已补过头部（类型/简介/演员），路数回来不再覆盖

    private var lines: List<PlayCache.Line> = emptyList()
    private var parses: List<Api.Parse> = emptyList()
    private var lineIdx = 0
    private var epIdx = 0

    private lateinit var ivBackdrop: ImageView
    private lateinit var rvLines: RecyclerView
    private lateinit var rvEps: RecyclerView
    private lateinit var rvCast: RecyclerView
    private lateinit var castAdapter: CastAdapter
    private lateinit var tvPlot: TextView
    private lateinit var tvMeta: TextView
    private lateinit var labEps: TextView
    private lateinit var labLines: TextView
    private lateinit var labCast: TextView
    private lateinit var btnFav: TextView
    private lateinit var btnPlay: TextView
    private lateinit var tvLineHint: TextView
    private lateinit var btnRetry: TextView
    private val ui = Handler(Looper.getMainLooper())

    private val title by lazy { intent.getStringExtra("title").orEmpty() }
    private val year by lazy { intent.getStringExtra("year").orEmpty() }
    private val inPoster by lazy { intent.getStringExtra("poster").orEmpty() }
    private val inBackdrop by lazy { intent.getStringExtra("backdrop").orEmpty() }
    private val inScore by lazy { intent.getStringExtra("score").orEmpty() }
    private val inMedia by lazy { intent.getStringExtra("media").orEmpty() }
    private val inId by lazy { intent.getStringExtra("id").orEmpty() }
    private val inSid by lazy { intent.getStringExtra("sid").orEmpty() }

    // 卡片 id 全是数字 = TMDB 条目（db_ 豆瓣 / av_ 上游 / 采集站 id 都不是）
    private val isTmdb get() = Api.isTmdbId(inId)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_detail)

        ivBackdrop = findViewById(R.id.ivBackdrop)
        rvLines = findViewById(R.id.rvLines)
        rvEps = findViewById(R.id.rvEps)
        rvCast = findViewById(R.id.rvCast)
        tvPlot = findViewById(R.id.tvPlot)
        tvMeta = findViewById(R.id.tvMeta)
        labEps = findViewById(R.id.labEps)
        labLines = findViewById(R.id.labLines)
        labCast = findViewById(R.id.labCast)
        btnFav = findViewById(R.id.btnFav)
        btnPlay = findViewById(R.id.btnPlay)
        tvLineHint = findViewById(R.id.tvLineHint)
        btnRetry = findViewById(R.id.btnRetry)

        // ---------- 头部：卡片数据秒画（不等任何网络） ----------
        findViewById<TextView>(R.id.tvTitle).text = title
        paintMeta(emptyList(), inScore, year)
        tvPlot.text = "简介加载中…"
        val pu = Api.dimg(inPoster)
        if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
        paintBackdrop()

        rvLines.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        // 列数按屏幕分档：详情页信息列只占屏宽 46%，选集列数比全屏网格收一档
        rvEps.layoutManager = GridLayoutManager(this, resources.getInteger(R.integer.detail_ep_cols))
        noAnim(rvLines)
        noAnim(rvEps)
        castAdapter = CastAdapter()
        rvCast.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        noAnim(rvCast)
        rvCast.adapter = castAdapter

        // 播放大按钮：线路没就绪前置灰不可点（截图里那颗绿色胶囊就绪才亮）
        btnPlay.isEnabled = false
        btnPlay.text = getString(R.string.line_loading)
        bindFocus(btnPlay)
        bindFocus(btnFav)
        bindFocus(btnRetry)
        btnPlay.setOnClickListener { startPlayer() }
        btnFav.setOnClickListener { toggleFav() }
        btnRetry.setOnClickListener { retryLoad() }
        tvLineHint.visibility = View.VISIBLE
        tvLineHint.text = "正在并发获取官方 / 采集线路…"

        // ---------- 数据：TMDB 详情增强 + 线路两路并发 ----------
        loadEnrich()
        val hit = cacheGet()
        if (hit != null) {
            // 有缓存：不挡屏直接进，线路在后台静默刷新
            settled = true
            when {
                hit.up != null -> applyUp(hit.up)
                hit.col != null -> applyCollect(hit.col)
            }
            load(quiet = true)
        } else {
            load(quiet = false)
            ui.postDelayed(safety, SETTLE_TIMEOUT)
        }
    }

    // ---------- 头部信息 ----------
    /* meta 行：类型 · 评分(金) · 年份。分段上色，评分那一段盖金。 */
    private fun paintMeta(genres: List<String>, score: String, yr: String) {
        val dim = ContextCompat.getColor(this, R.color.fg_dim)
        val gold = ContextCompat.getColor(this, R.color.gold)
        val sb = SpannableStringBuilder()
        fun seg(s: String, color: Int) {
            if (s.isBlank()) return
            if (sb.isNotEmpty()) sb.append(" · ")
            val from = sb.length
            sb.append(s)
            sb.setSpan(ForegroundColorSpan(color), from, sb.length, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        genres.filter { it.isNotBlank() }.forEach { seg(it, dim) }
        val sc = score.toDoubleOrNull()
        if (sc != null && sc > 0) seg("%.1f".format(sc), gold)
        seg(yr, dim)
        tvMeta.text = sb
    }

    /* TMDB 详情增强：类型/简介/演员圆头像（截图那套信息列的数据源）。
       非 TMDB 卡（豆瓣/采集）不走这里，简介等采集路数回来再补。 */
    private fun loadEnrich() {
        if (!isTmdb) { tvPlot.text = "这部片子没有更多介绍。"; return }
        lifecycleScope.launch {
            val d = withContext(Dispatchers.IO) { runCatching { Api.tmdbDetail(inMedia, inId) }.getOrNull() }
            if (d == null || isDestroyed) return@launch
            enriched = true
            paintMeta(
                d.genres?.map { it.name.orEmpty() }.orEmpty(),
                if ((d.vote_average ?: 0.0) > 0) "%.1f".format(d.vote_average!!) else "",
                (d.release_date ?: d.first_air_date).orEmpty().take(4).ifBlank { year }
            )
            tvPlot.text = buildString {
                append(if (d.overview.isNullOrBlank()) "这部片子没有更多介绍。" else d.overview)
                // 演员/导演文本行：采集路数给了就拼在后面（上游/ TMDB 详情不给这两行）
                val cast = collectReady?.plot.orEmpty().lineSequence()
                    .filter { it.startsWith("演员：") || it.startsWith("导演：") }.joinToString("\n")
                if (cast.isNotBlank()) append("\n\n").append(cast)
            }
            val cast = d.credits?.cast.orEmpty()
                .filter { !it.profile_path.isNullOrBlank() || !it.name.isNullOrBlank() }
                .take(6)
            if (cast.isNotEmpty()) {
                labCast.visibility = View.VISIBLE
                rvCast.visibility = View.VISIBLE
                castAdapter.submit(cast)
            }
            // 卡片没带剧照、TMDB 详情带了 → 背景升级成横版剧照
            if (inBackdrop.isBlank() && !d.backdrop_path.isNullOrBlank()) paintBackdrop(d.backdrop_path)
        }
    }

    /* 全屏背景：优先横版剧照（TMDB w1280 / 豆瓣 backdrop），没有就用海报裁切铺满。
       截图样式是清晰大图，不糊；可读性交给左暗右淡渐变遮罩。 */
    private fun paintBackdrop(raw: String? = null) {
        val u = if (!raw.isNullOrBlank()) Api.tmdbBackdropUrl(raw) else Api.dimg(inPoster)
        if (u.isBlank()) { ivBackdrop.setImageDrawable(null); return }
        ivBackdrop.load(u) { crossfade(true) }
    }

    // ---------- 详情缓存：第二次进同一部片不挡屏 ----------
    private fun cacheKey(): String = title.trim() + "|" + year.trim()

    private fun cacheGet(): CacheEntry? {
        synchronized(detailCache) {
            val e = detailCache[cacheKey()] ?: return null
            if (System.currentTimeMillis() - e.t > CACHE_TTL) {
                detailCache.remove(cacheKey())
                return null
            }
            return e
        }
    }

    private fun cachePut() {
        synchronized(detailCache) {
            // 静默刷新时某一路没拿到就沿用旧缓存的那一路，别把好数据刷没了
            val old = detailCache[cacheKey()]
            val up = upReady ?: old?.up
            val col = collectReady ?: old?.col
            if (up == null && col == null) return
            detailCache[cacheKey()] = CacheEntry(up, col)
        }
    }

    // 线路兜底：到点用手里有的（信息页一直在，用户先看着简介）
    private val safety = Runnable { expired = true; maybeSettle(force = true) }

    /* 有一路到位就渲染（官方优先）；全失败或到点也渲染（失败态给重试入口）。 */
    private fun maybeSettle(force: Boolean = false) {
        synchronized(settleLock) {
            if (settled) return
            val have = upReady != null || collectReady != null
            if (!have && !force && !(upDone && collectDone)) return
            settled = true
        }
        ui.removeCallbacks(safety)
        when {
            upReady != null -> { applyUp(upReady!!); cachePut() }
            collectReady != null -> { applyCollect(collectReady!!); cachePut() }
            else -> failState()
        }
    }

    /* 官方/采集都没取到：按钮置灰给出提示 + 重试入口，别让用户干瞪眼 */
    private fun failState() {
        btnPlay.isEnabled = false
        btnPlay.text = "暂无片源"
        tvLineHint.visibility = View.VISIBLE
        tvLineHint.text = "官方 / 采集线路都没取到，可能是站方接口抽风或片名对不上"
        labEps.text = "暂无片源"
        btnRetry.visibility = View.VISIBLE
        btnRetry.requestFocus()
    }

    /* 「刷新重试」：清空本次的失败结果并重置加载状态，重新去拉片源。
       先把这条片的详情缓存清掉，否则 quiet 静默刷新会把上次的空结果又喂回来。 */
    private fun retryLoad() {
        if (!settled) return            // 还在加载中，不重复触发
        synchronized(detailCache) { detailCache.remove(cacheKey()) }
        upReady = null
        collectReady = null
        upDone = false
        collectDone = false
        expired = false
        settled = false
        btnRetry.visibility = View.GONE
        btnPlay.isEnabled = false
        btnPlay.text = getString(R.string.line_loading)
        tvLineHint.visibility = View.VISIBLE
        tvLineHint.text = "正在并发获取官方 / 采集线路…"
        load(quiet = false)
        ui.postDelayed(safety, SETTLE_TIMEOUT)
    }

    /* 精确取（站点 id + 站内 id）和按名聚合必须一起跑：
       只精确取的话永远只有「卡片所属那一个站」的线路，
       后台明明配了五六个采集站，TV 里却只剩一条。 */
    private suspend fun fetchAll(): Api.PlayResp? = withContext(Dispatchers.IO) {
        val byId = if (inSid.isNotBlank() && inId.isNotBlank()) {
            async { runCatching { Api.playByVid(inSid, inId) }.getOrNull() }
        } else null
        val byName = async { runCatching { Api.playByName(title, year) }.getOrNull() }
        mergePlay(byId?.await(), byName.await())
    }

    private fun mergePlay(a: Api.PlayResp?, b: Api.PlayResp?): Api.PlayResp? {
        val out = mutableListOf<Api.PlayRes>()
        val seen = HashSet<String>()
        for (r in (a?.results.orEmpty() + b?.results.orEmpty())) {
            if (r.sources.isNullOrEmpty()) continue
            val k = (r.stationId ?: "") + "|" + (r.id ?: "")
            if (seen.add(k)) out.add(r)
        }
        val pl = if (!a?.parseList.isNullOrEmpty()) a!!.parseList!! else b?.parseList.orEmpty()
        if (out.isEmpty()) return null
        return Api.PlayResp(results = out, parseList = pl, hasParse = pl.isNotEmpty())
    }

    // ⚡ 两路并发：谁先回来先存着，有一路到位就渲染（遮罩时代是等两边，现在信息页秒开）
    /* quiet=true：缓存命中后的静默刷新 —— 结果只写缓存不重渲染，
       否则页面会当着用户的面从一条线路跳成另一条（闪跳很难看）。 */
    private fun load(quiet: Boolean) {
        lifecycleScope.launch { runCatching { loadUp(quiet) } }
        lifecycleScope.launch { runCatching { loadCollect(quiet) } }
    }

    // 去掉「第X季 / Season N」再去检索：上游按裸片名归档，带着季名经常搜不到
    private fun bareTitle(): String =
        title.replace(Regex("\\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\\s*$"), "")
            .replace(Regex("\\s*Season\\s*\\d+\\s*$", RegexOption.IGNORE_CASE), "")
            .trim().ifBlank { title }

    private suspend fun loadUp(quiet: Boolean) {
        val r = withContext(Dispatchers.IO) {
            var upId = if (inId.startsWith("av_")) inId else ""
            if (upId.isBlank()) {
                val s = runCatching { Api.upSearch(bareTitle()) }.getOrNull()
                upId = s?.items.orEmpty().firstOrNull { it.id.orEmpty().startsWith("av_") }?.id.orEmpty()
                if (upId.isBlank() && bareTitle() != title) {
                    val s2 = runCatching { Api.upSearch(title) }.getOrNull()
                    upId = s2?.items.orEmpty().firstOrNull { it.id.orEmpty().startsWith("av_") }?.id.orEmpty()
                }
            }
            if (upId.isBlank()) return@withContext null
            val d = runCatching { Api.upDetail(upId, quick = true) }.getOrNull() ?: return@withContext null
            if (d.noUpstream) return@withContext null
            val eps = (d.episodes?.episodes ?: d.episodes?.items ?: d.episodes?.list).orEmpty()
                .filter { Api.epToken(it).isNotBlank() }
            if (eps.isEmpty()) return@withContext null
            val ls = runCatching { Api.upLineList(Api.epToken(eps[0])) }.getOrNull()?.lines.orEmpty()
            UpReady(
                eps = eps,
                upLines = ls,
                title = d.detail?.title ?: d.detail?.normalized_title ?: title,
                year = d.detail?.year ?: year,
                itemId = upId,
                kind = (d.detail?.content_kind ?: d.detail?.kind ?: d.detail?.type) ?: "",
                poster = (d.detail?.poster_url ?: inPoster).orEmpty(),
                plot = (d.detail?.overview ?: d.detail?.description).orEmpty()
            )
        }
        upDone = true
        if (r != null) upReady = r
        withContext(Dispatchers.Main) { if (quiet) cachePut() else maybeSettle() }
    }

    private fun loadCollect(quiet: Boolean) {
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                val resp = fetchAll() ?: return@withContext null
                val results = resp.results.orEmpty()
                if (results.isEmpty()) return@withContext null

                val flat = mutableListOf<PlayCache.Line>()
                for (x in results) {
                    val st = x.station ?: "采集"
                    for (s in x.sources.orEmpty()) {
                        val eps = s.episodes.orEmpty().filter { !it.url.isNullOrBlank() }
                        if (eps.isNotEmpty()) flat.add(PlayCache.Line(st, s.from ?: "线路", eps))
                    }
                }
                if (flat.isEmpty()) return@withContext null

                val d = results.firstOrNull { it.detail != null }?.detail
                val head = results.firstOrNull { !it.name.isNullOrBlank() } ?: results.first()
                val meta = listOf(head.year, d?.type, d?.area, d?.lang, d?.remark).filter { !it.isNullOrBlank() }
                val plot = buildString {
                    if (!d?.plot.isNullOrBlank()) append(d!!.plot).append("\n\n")
                    if (!d?.actors.isNullOrBlank()) append("演员：").append(d!!.actors).append("\n")
                    if (!d?.director.isNullOrBlank()) append("导演：").append(d!!.director)
                }
                CollectReady(
                    lines = PlayCache.sorted(flat),
                    parses = resp.parseList.orEmpty(),
                    title = title,
                    year = year,
                    // 豆瓣卡的 db_ 前缀 id 只在本站首页有意义，存进历史/收藏会和网页端对不上
                    itemId = if (inId.isNotBlank() && !inId.startsWith("db_")) inId
                    else PlayCache.synthId(title, year),
                    poster = (results.firstOrNull { !it.poster.isNullOrBlank() }?.poster ?: inPoster).orEmpty(),
                    headName = head.name ?: title,
                    score = head.remark.orEmpty(),
                    meta = meta.joinToString(" · "),
                    plot = plot
                )
            }
            collectDone = true
            if (r != null) collectReady = r
            withContext(Dispatchers.Main) { if (quiet) cachePut() else maybeSettle() }
        }
    }

    // ---------- 渲染（settle 后各跑一次） ----------
    private fun applyUp(r: UpReady) {
        PlayCache.clearUp()
        lines = emptyList()
        parses = emptyList()
        PlayCache.lines = emptyList()
        PlayCache.isUp = true
        PlayCache.upEps = r.eps
        PlayCache.upSkip = 0
        PlayCache.title = r.title
        PlayCache.year = r.year
        PlayCache.itemId = r.itemId
        PlayCache.upKind = r.kind
        PlayCache.poster = r.poster
        PlayCache.parseList = emptyList()
        PlayCache.hasParse = false

        // 头部：TMDB 详情补过了就不拿路数数据覆盖（类型/简介/演员以 TMDB 为准）
        if (!enriched) {
            findViewById<TextView>(R.id.tvMeta).text =
                listOfNotNull(r.year, collectReady?.meta?.takeIf { it.isNotBlank() && it != r.year })
                    .joinToString(" · ")
            tvPlot.text = buildString {
                if (r.plot.isBlank()) append("这部片子没有更多介绍。") else append(r.plot)
                val cast = collectReady?.plot.orEmpty().lineSequence()
                    .filter { it.startsWith("演员：") || it.startsWith("导演：") }.joinToString("\n")
                if (cast.isNotBlank()) append("\n\n").append(cast)
            }
        }
        val pu = Api.dimg(r.poster)
        if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
        if (inBackdrop.isBlank()) paintBackdrop(r.poster)
        paintUp()
        armPlayButton()
        refreshFavState()
    }

    private fun applyCollect(r: CollectReady) {
        PlayCache.clearUp()
        lines = r.lines
        parses = r.parses
        PlayCache.lines = r.lines
        PlayCache.parseList = r.parses
        PlayCache.hasParse = r.parses.isNotEmpty()
        PlayCache.title = r.title
        PlayCache.year = r.year
        PlayCache.itemId = r.itemId
        PlayCache.poster = r.poster

        if (!enriched) {
            findViewById<TextView>(R.id.tvMeta).text = r.meta
            tvPlot.text = if (r.plot.isBlank()) "这部片子没有更多介绍。" else r.plot
        }
        val pu = Api.dimg(r.poster)
        if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
        if (inBackdrop.isBlank()) paintBackdrop(r.poster)
        paint()
        armPlayButton()
        refreshFavState()
    }

    private fun paint() {
        if (PlayCache.isUp) { paintUp(); return }
        if (lines.isEmpty()) { labEps.text = "暂无片源"; return }
        // 重试后线路列表可能变短，旧下标先收回来再取
        lineIdx = lineIdx.coerceIn(0, lines.size - 1)
        labLines.text = "播放线路 · ${lines.size} 条"
        val names = lines.map {
            val tag = if (PlayCache.isOfficial(it)) "★ " else ""
            tag + it.station + " · " + it.from + " (" + it.eps.size + ")"
        }
        rvLines.adapter = ChipAdapter(names, { lineIdx }, wrap = true) { i ->
            lineIdx = i
            epIdx = 0
            rvLines.adapter?.notifyDataSetChanged()
            paintEps()
        }
        labEps.text = "选集（共 ${lines[lineIdx].eps.size} 集）"
        paintEps()
    }

    // 上游模式：第一条「智能选择」= 服务端官方优先 + 失败自动顺延；后面是换源面板里那几条
    private fun paintUp() {
        labLines.text = "播放线路 · ${PlayCache.upLines.size + 1} 条"
        val names = mutableListOf("智能选择")
        names.addAll(PlayCache.upLines.map {
            (if (it.official == true) "★ " else "") + (it.label ?: "线路") +
                (if (it.selected == true) " ·推荐" else "")
        })
        rvLines.adapter = ChipAdapter(names, { if (PlayCache.upSkip <= 0) 0 else PlayCache.upSkip + 1 }, wrap = true) { i ->
            PlayCache.upSkip = if (i == 0) 0 else i - 1
            epIdx = 0
            rvLines.adapter?.notifyDataSetChanged()
            paintEps()
        }
        labEps.text = "选集（共 ${PlayCache.upEps.size} 集）"
        paintEps()
    }

    private fun paintEps() {
        val names: List<String> = if (PlayCache.isUp)
            PlayCache.upEps.mapIndexed { i, e -> Api.epName(e, i) }
        else lines[lineIdx].eps.mapIndexed { i, e -> e.name ?: "第${i + 1}集" }
        rvEps.adapter = ChipAdapter(names, { epIdx }) { i ->
            epIdx = i
            rvEps.adapter?.notifyDataSetChanged()
            startPlayer()
        }
    }

    /* 播放大按钮点亮：线路就绪 = 有媒体信息可播。
       文案按本地续播进度走：看过没看完 → 「继续 第N集」；没看过 → 第1集/播放。 */
    private fun armPlayButton() {
        val total = if (PlayCache.isUp) PlayCache.upEps.size
        else lines.getOrNull(lineIdx)?.eps?.size ?: 0
        if (total <= 0) { failState(); return }
        var contEp = -1
        for (i in 0 until total) {
            val (pos, dur) = Prefs.getProgress(PlayCache.progressKey(PlayCache.title, i))
            // 看过 10 秒以上、又没播完（95%）才算「继续」，刚点开就退出的别算
            if (dur > 0 && pos >= 10000 && pos < dur * 0.95) { contEp = i; break }
        }
        epIdx = if (contEp >= 0) contEp else 0
        lineIdx = lineIdx.coerceAtLeast(0)
        btnPlay.isEnabled = true
        // 片名里带了「第X季」就拼上（截图样式：继续 第4季第12集）
        val season = Regex("第([一二三四五六七八九十0-9]+)季").find(title)?.groupValues?.get(1)
        fun epLabel(n: Int): String =
            if (season != null) "第${season}季第${n}集" else "第${n}集"
        btnPlay.text = when {
            contEp >= 0 -> getString(R.string.play_continue, epLabel(contEp + 1))
            total <= 1 -> getString(R.string.play_movie)
            else -> getString(R.string.play_first_ep, epLabel(1))
        }
        tvLineHint.visibility = View.GONE
        rvEps.adapter?.notifyDataSetChanged()
        btnPlay.requestFocus()
    }

    private fun startPlayer() {
        if (PlayCache.isUp) {
            if (PlayCache.upEps.isEmpty()) { toast("线路还没就绪，等一下再按"); return }
        } else if (lines.isEmpty()) {
            toast("线路还没就绪，等一下再按"); return
        }
        val i = Intent(this, PlayerActivity::class.java)
        i.putExtra("line", lineIdx)
        i.putExtra("ep", epIdx)
        startActivity(i)
    }

    private fun toggleFav() {
        lifecycleScope.launch {
            val on = withContext(Dispatchers.IO) {
                runCatching {
                    Api.toggleFav(
                        Api.HistItem(
                            id = PlayCache.itemId, title = title,
                            poster = PlayCache.poster, year = year
                        )
                    )
                }.getOrNull()
            }
            if (on == null) toast("收藏失败，可能没开收藏权限")
            else {
                btnFav.text = if (on) getString(R.string.fav_on) else getString(R.string.fav_off)
                toast(if (on) "已收藏" else "已取消收藏")
            }
        }
    }

    // 进来先把收藏状态摆正（之前进来总是「☆ 收藏」，已收藏的看不出来）
    private fun refreshFavState() {
        val id = PlayCache.itemId
        if (id.isBlank()) return
        lifecycleScope.launch {
            val on = withContext(Dispatchers.IO) { runCatching { Api.isFav(id) }.getOrNull() }
            if (!isDestroyed) btnFav.text = if (on == true) getString(R.string.fav_on) else getString(R.string.fav_off)
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        ui.removeCallbacks(safety)
        super.onDestroy()
    }
}
