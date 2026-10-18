package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class DetailActivity : AppCompatActivity() {

    companion object {
        fun open(ctx: Context, c: Api.Card) {
            val i = Intent(ctx, DetailActivity::class.java)
            i.putExtra("title", c.title.orEmpty())
            i.putExtra("year", c.year.orEmpty())
            i.putExtra("poster", c.poster.orEmpty())
            i.putExtra("id", c.id.orEmpty())
            i.putExtra("sid", c.station.orEmpty())
            i.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            ctx.startActivity(i)
        }

        // 加载遮罩的最长等待秒数：官方 + 采集都到位会提前进，到点还没齐就用手里有的
        private const val WAIT_SEC = 15
    }

    /* 两路结果先各存各的，等「官方 + 采集」都到位（或倒计时到点/用户按立即播放）
       再一次性渲染 —— 不然会先看到 360zy 又跳成智能选择，很难看。 */
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

    private var lines: List<PlayCache.Line> = emptyList()
    private var parses: List<Api.Parse> = emptyList()
    private var lineIdx = 0
    private var epIdx = 0

    private lateinit var rvLines: RecyclerView
    private lateinit var rvEps: RecyclerView
    private lateinit var tvPlot: TextView
    private lateinit var labEps: TextView
    private lateinit var labLines: TextView
    private lateinit var btnFav: TextView
    private lateinit var overlay: View
    private lateinit var tvLoadCount: TextView
    private lateinit var tvLoadInfo: TextView
    private lateinit var btnLoadPlay: TextView
    private val ui = Handler(Looper.getMainLooper())

    private val title by lazy { intent.getStringExtra("title").orEmpty() }
    private val year by lazy { intent.getStringExtra("year").orEmpty() }
    private val inPoster by lazy { intent.getStringExtra("poster").orEmpty() }
    private val inId by lazy { intent.getStringExtra("id").orEmpty() }
    private val inSid by lazy { intent.getStringExtra("sid").orEmpty() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_detail)

        rvLines = findViewById(R.id.rvLines)
        rvEps = findViewById(R.id.rvEps)
        tvPlot = findViewById(R.id.tvPlot)
        labEps = findViewById(R.id.labEps)
        labLines = findViewById(R.id.labLines)
        btnFav = findViewById(R.id.btnFav)
        overlay = findViewById(R.id.loadOverlay)
        tvLoadCount = findViewById(R.id.tvLoadCount)
        tvLoadInfo = findViewById(R.id.tvLoadInfo)
        btnLoadPlay = findViewById(R.id.btnLoadPlay)

        findViewById<TextView>(R.id.tvTitle).text = title
        findViewById<TextView>(R.id.tvMeta).text = year
        val u = Api.dimg(inPoster)
        if (u.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(u)

        rvLines.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        rvEps.layoutManager = GridLayoutManager(this, 8)
        noAnim(rvLines)
        noAnim(rvEps)

        val btnPlay = findViewById<TextView>(R.id.btnPlay)
        bindFocus(btnPlay) { has -> btnPlay.alpha = if (has) 1f else 0.9f }
        bindFocus(btnFav) { has -> btnFav.alpha = if (has) 1f else 0.9f }
        btnPlay.setOnClickListener { startPlayer() }
        btnFav.setOnClickListener { toggleFav() }

        // 遮罩上的「立即播放」：不等了，手里有什么就用什么直接开
        bindFocus(btnLoadPlay) { has -> btnLoadPlay.alpha = if (has) 1f else 0.9f }
        btnLoadPlay.setOnClickListener {
            settle(true)
            startPlayer()
        }

        startTicker()
        load()
    }

    // ---------- 加载遮罩：倒计时 + 进度 ----------
    private fun startTicker() {
        overlay.visibility = View.VISIBLE
        ui.post(tick)
    }

    private val tick = object : Runnable {
        private var left = WAIT_SEC
        override fun run() {
            if (settled) return
            tvLoadCount.text = "正在优化加载线路… ${left}s"
            paintProgress()
            left--
            if (left <= 0) {
                expired = true
                settle(false)
                return
            }
            ui.postDelayed(this, 1000)
        }
    }

    private fun paintProgress() {
        val n = (upReady?.upLines?.size ?: 0) + (collectReady?.lines?.size ?: 0)
        val pending = mutableListOf<String>()
        if (!upDone) pending.add("官方")
        if (!collectDone) pending.add("采集")
        tvLoadInfo.text = if (pending.isEmpty())
            "已找到 $n 条线路，正在进入…"
        else
            "已找到 $n 条线路 · " + pending.joinToString(" / ") + "线路加载中"
    }

    private fun settleIfReady() = settle(false)

    private fun settle(force: Boolean) {
        synchronized(settleLock) {
            if (settled) return
            if (!force && !expired && !(upDone && collectDone)) return
            settled = true
        }
        ui.removeCallbacks(tick)

        val up = upReady
        val col = collectReady
        when {
            up != null -> applyUp(up)
            col != null -> applyCollect(col)
            else -> {
                overlay.visibility = View.GONE
                tvPlot.text = "这部片子暂时取不到片源。\n\n可能是站方接口抽风、片名对不上，或者后台还没配采集站，稍后再试一次。"
                labEps.text = "暂无片源"
            }
        }
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

    // ⚡ 两路并发：谁先回来先存着，等两边都到位再渲染（遮罩上能看到进度和倒计时）
    private fun load() {
        lifecycleScope.launch { runCatching { loadUp() } }
        lifecycleScope.launch { runCatching { loadCollect() } }
    }

    // 去掉「第X季 / Season N」再去检索：上游按裸片名归档，带着季名经常搜不到
    private fun bareTitle(): String =
        title.replace(Regex("\\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\\s*$"), "")
            .replace(Regex("\\s*Season\\s*\\d+\\s*$", RegexOption.IGNORE_CASE), "")
            .trim().ifBlank { title }

    private suspend fun loadUp() {
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
        withContext(Dispatchers.Main) { settleIfReady() }
    }

    private fun loadCollect() {
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
            withContext(Dispatchers.Main) { settleIfReady() }
        }
    }

    // ---------- 渲染（只在 settle 后各跑一次） ----------
    private fun applyUp(r: UpReady) {
        overlay.visibility = View.GONE
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

        findViewById<TextView>(R.id.tvTitle).text = r.title
        findViewById<TextView>(R.id.tvMeta).text = r.year
        val pu = Api.dimg(r.poster)
        if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
        val kind = r.kind
        tvPlot.text = buildString {
            if (kind.isNotBlank()) append("类型：").append(kind).append("\n\n")
            append(if (r.plot.isBlank()) "这部片子没有更多介绍。" else r.plot)
        }
        paintUp()
    }

    private fun applyCollect(r: CollectReady) {
        overlay.visibility = View.GONE
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

        findViewById<TextView>(R.id.tvTitle).text = r.headName
        findViewById<TextView>(R.id.tvScore).text = r.score
        findViewById<TextView>(R.id.tvMeta).text = r.meta
        val pu = Api.dimg(r.poster)
        if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
        tvPlot.text = if (r.plot.isBlank()) "这部片子没有更多介绍。" else r.plot
        paint()
    }

    private fun paint() {
        if (PlayCache.isUp) { paintUp(); return }
        if (lines.isEmpty()) { labEps.text = "暂无片源"; return }
        labLines.text = "播放线路 · ${lines.size} 条"
        val names = lines.map {
            val tag = if (PlayCache.isOfficial(it)) "★ " else ""
            tag + it.station + " · " + it.from + " (" + it.eps.size + ")"
        }
        rvLines.adapter = ChipAdapter(names, { lineIdx }) { i ->
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
        rvLines.adapter = ChipAdapter(names, { if (PlayCache.upSkip <= 0) 0 else PlayCache.upSkip + 1 }) { i ->
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
                btnFav.text = if (on) "★ 已收藏" else "☆ 收藏"
                toast(if (on) "已收藏" else "已取消收藏")
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        ui.removeCallbacks(tick)
        super.onDestroy()
    }
}
