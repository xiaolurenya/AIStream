package io.github.xiaolurenya.aistream.tv

import android.content.Context
import android.content.Intent
import android.os.Bundle
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
    }

    private var lines: List<PlayCache.Line> = emptyList()
    private var parses: List<Api.Parse> = emptyList()
    private var lineIdx = 0
    private var parseIdx = 0
    private var epIdx = 0

    private lateinit var rvLines: RecyclerView
    private lateinit var rvEps: RecyclerView
    private lateinit var rvParse: RecyclerView
    private lateinit var labParse: TextView
    private lateinit var tvPlot: TextView
    private lateinit var labEps: TextView
    private lateinit var btnFav: TextView

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
        rvParse = findViewById(R.id.rvParse)
        labParse = findViewById(R.id.labParse)
        tvPlot = findViewById(R.id.tvPlot)
        labEps = findViewById(R.id.labEps)
        btnFav = findViewById(R.id.btnFav)

        findViewById<TextView>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<TextView>(R.id.tvTitle).text = title
        findViewById<TextView>(R.id.tvMeta).text = year
        val u = Api.dimg(inPoster)
        if (u.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(u)

        rvLines.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        rvParse.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        rvEps.layoutManager = GridLayoutManager(this, 4)

        btnFav.setOnClickListener { toggleFav() }

        load()
    }

    // 精确取（站点 id + 站内 id）和按名聚合必须一起跑：
    // 只精确取的话永远只有「卡片所属那一个站」的线路，
    // 后台明明配了五六个采集站，APP 里却只剩一条（表现为「只有 360zy」）。
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

    private fun load() {
        lifecycleScope.launch {
            // 先试上游：站点配了上游时，那二十几条线路是解析时动态挑的，
            // 采集站聚合根本拿不到（表现就是「只有 360zy」）。没配上游/检索不到就安静降级。
            if (loadUp()) return@launch
            loadCollect()
        }
    }

    // 去掉「第X季 / Season N」再去检索：上游按裸片名归档，带着季名经常搜不到（网页端同款处理）
    private fun bareTitle(): String =
        title.replace(Regex("\\s*[（(]?第[一二三四五六七八九十0-9]+季[）)]?\\s*$"), "")
            .replace(Regex("\\s*Season\\s*\\d+\\s*$", RegexOption.IGNORE_CASE), "")
            .trim().ifBlank { title }

    private suspend fun loadUp(): Boolean = withContext(Dispatchers.IO) {
        var upId = if (inId.startsWith("av_")) inId else ""
        if (upId.isBlank()) {
            val s = runCatching { Api.upSearch(bareTitle()) }.getOrNull()
            upId = s?.items.orEmpty().firstOrNull { it.id.orEmpty().startsWith("av_") }?.id.orEmpty()
            if (upId.isBlank() && bareTitle() != title) {
                val s2 = runCatching { Api.upSearch(title) }.getOrNull()
                upId = s2?.items.orEmpty().firstOrNull { it.id.orEmpty().startsWith("av_") }?.id.orEmpty()
            }
        }
        if (upId.isBlank()) return@withContext false
        val d = runCatching { Api.upDetail(upId, quick = true) }.getOrNull() ?: return@withContext false
        if (d.noUpstream) return@withContext false
        val eps = (d.episodes?.episodes ?: d.episodes?.items ?: d.episodes?.list).orEmpty()
            .filter { Api.epToken(it).isNotBlank() }
        if (eps.isEmpty()) return@withContext false

        PlayCache.clearUp()
        PlayCache.lines = emptyList()
        PlayCache.isUp = true
        PlayCache.upEps = eps
        PlayCache.upSkip = 0
        PlayCache.title = d.detail?.title ?: d.detail?.normalized_title ?: title
        PlayCache.year = d.detail?.year ?: year
        PlayCache.itemId = upId
        PlayCache.upKind = (d.detail?.content_kind ?: d.detail?.kind ?: d.detail?.type) ?: ""
        PlayCache.poster = (d.detail?.poster_url ?: inPoster).orEmpty()
        // 线路列表拿第一集凭证查一次：debug=1 只列出不真播，服务端有缓存，开销很小
        PlayCache.upLines = runCatching { Api.upLineList(Api.epToken(eps[0])) }.getOrNull()?.lines.orEmpty()

        withContext(Dispatchers.Main) {
            findViewById<TextView>(R.id.tvTitle).text = PlayCache.title
            findViewById<TextView>(R.id.tvScore).text = ""
            findViewById<TextView>(R.id.tvMeta).text = PlayCache.year
            val pu = Api.dimg(PlayCache.poster)
            if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)
            val plot = (d.detail?.overview ?: d.detail?.description).orEmpty()
            tvPlot.text = if (plot.isBlank()) "这部片子没有更多介绍。" else plot
            lines = emptyList()
            parses = emptyList()
            PlayCache.parseList = emptyList()
            PlayCache.hasParse = false
            parseIdx = 0
            paint()
        }
        true
    }

    private fun loadCollect() {
        lifecycleScope.launch {
            // 这条路只走采集站聚合，先把上游模式的残留清干净
            PlayCache.clearUp()
            val resp = fetchAll()

            if (resp == null) {
                Toast.makeText(this@DetailActivity, "取片源失败，检查站点连通性", Toast.LENGTH_SHORT).show()
                return@launch
            }

            val results = resp.results.orEmpty()
            if (results.isEmpty()) {
                labEps.text = "暂无片源"
                tvPlot.text = "没有采集站返回这部片子的播放地址。\n\n" +
                    "常见于：站方关掉了搜索接口、片名对不上、或者后台还没配采集站。"
                return@launch
            }

            parses = resp.parseList.orEmpty()
            PlayCache.parseList = parses
            PlayCache.hasParse = parses.isNotEmpty()
            PlayCache.parseIndex = 0
            parseIdx = 0
            PlayCache.title = title
            PlayCache.year = year
            // 豆瓣卡的 db_ 前缀 id 只在本站首页有意义，存进历史/收藏会和网页端对不上，统一换成合成 id
            PlayCache.itemId = if (inId.isNotBlank() && !inId.startsWith("db_")) inId
            else PlayCache.synthId(title, year)

            val best = results.firstOrNull { !it.poster.isNullOrBlank() }
            PlayCache.poster = (best?.poster ?: inPoster).orEmpty()
            val pu = Api.dimg(PlayCache.poster)
            if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)

            // 标题/详情优先展示「第一条有内容的站」，别拿到空壳条目
            val first = results.firstOrNull { !it.name.isNullOrBlank() } ?: results.first()
            findViewById<TextView>(R.id.tvTitle).text = first.name ?: title
            findViewById<TextView>(R.id.tvScore).text = first.remark.orEmpty()

            val d = results.firstOrNull { it.detail != null }?.detail
            val meta = listOf(first.year, d?.type, d?.area, d?.remark).filter { !it.isNullOrBlank() }
            findViewById<TextView>(R.id.tvMeta).text = meta.joinToString(" · ")

            val plot = buildString {
                if (!d?.plot.isNullOrBlank()) append(d!!.plot).append("\n\n")
                if (!d?.actors.isNullOrBlank()) append("演员：").append(d!!.actors).append("\n")
                if (!d?.director.isNullOrBlank()) append("导演：").append(d!!.director)
            }
            tvPlot.text = if (plot.isBlank()) "这部片子没有更多介绍。" else plot

            // 站点 × 线路 摊平：换源就是把这两级合成一条列表，点哪条播哪条
            val flat = mutableListOf<PlayCache.Line>()
            for (r in results) {
                val st = r.station ?: "采集"
                for (s in r.sources.orEmpty()) {
                    val eps = s.episodes.orEmpty().filter { !it.url.isNullOrBlank() }
                    if (eps.isNotEmpty()) flat.add(PlayCache.Line(st, s.from ?: "线路", eps))
                }
            }
            if (flat.isEmpty()) {
                labEps.text = "暂无分集"
                return@launch
            }

            lines = PlayCache.sorted(flat)
            PlayCache.lines = lines
            paint()
        }
    }

    private fun paint() {
        if (PlayCache.isUp) { paintUp(); return }
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
        paintParse()

        findViewById<TextView>(R.id.btnPlay).setOnClickListener { startPlayer() }
    }

    // 上游模式：第一条「智能选择」= 服务端官方优先 + 失败自动顺延；
    // 后面是换源面板里那几条，点了就把 skip 下标喂给 resolve
    private fun paintUp() {
        val names = mutableListOf("智能选择")
        names.addAll(PlayCache.upLines.map {
            (if (it.official == true) "★ " else "") + (it.label ?: "线路") + (if (it.selected == true) " ·推荐" else "")
        })
        // picked 必须实时读 PlayCache：点完换线只 notifyDataSetChanged，本地算好的值会过期
        rvLines.adapter = ChipAdapter(names, { if (PlayCache.upSkip <= 0) 0 else PlayCache.upSkip + 1 }) { i ->
            PlayCache.upSkip = if (i == 0) 0 else i - 1
            epIdx = 0
            rvLines.adapter?.notifyDataSetChanged()
            paintEps()
        }
        labEps.text = "选集（共 ${PlayCache.upEps.size} 集）"
        paintEps()
        labParse.visibility = View.GONE
        rvParse.visibility = View.GONE

        findViewById<TextView>(R.id.btnPlay).setOnClickListener { startPlayer() }
    }

    // 后台配了多条解析线路时列出来让用户挑：非直链片源要靠它才能播
    private fun paintParse() {
        if (parses.isEmpty()) {
            labParse.visibility = View.GONE
            rvParse.visibility = View.GONE
            return
        }
        labParse.visibility = View.VISIBLE
        rvParse.visibility = View.VISIBLE
        val names = parses.map { it.name ?: "解析器" }
        rvParse.adapter = ChipAdapter(names, { parseIdx }) { i ->
            parseIdx = i
            PlayCache.parseIndex = i
            rvParse.adapter?.notifyDataSetChanged()
            Toast.makeText(this, "已选解析器：" + (parses[i].name ?: ""), Toast.LENGTH_SHORT).show()
        }
    }

    private fun paintEps() {
        val names: List<String> = if (PlayCache.isUp)
            PlayCache.upEps.mapIndexed { i, e -> Api.epName(e, i) }
        else lines[lineIdx].eps.mapIndexed { i, e -> e.name ?: "第${i + 1}集" }
        rvEps.adapter = ChipAdapter(names, { epIdx }) { i ->
            epIdx = i
            startPlayer()
        }
    }

    private fun startPlayer() {
        if (PlayCache.isUp) {
            if (PlayCache.upEps.isEmpty()) {
                Toast.makeText(this, "没有可用分集", Toast.LENGTH_SHORT).show()
                return
            }
            val i = Intent(this, PlayerActivity::class.java)
            i.putExtra("line", 0)
            i.putExtra("ep", epIdx)
            startActivity(i)
            return
        }
        if (lines.isEmpty()) {
            Toast.makeText(this, "没有可用线路", Toast.LENGTH_SHORT).show()
            return
        }
        PlayCache.parseIndex = parseIdx
        val i = Intent(this, PlayerActivity::class.java)
        i.putExtra("line", lineIdx)
        i.putExtra("ep", epIdx)
        startActivity(i)
    }

    private fun toggleFav() {
        lifecycleScope.launch {
            val on = withContext(Dispatchers.IO) {
                runCatching {
                    val item = Api.HistItem(
                        id = PlayCache.itemId, title = title, poster = PlayCache.poster, year = year
                    )
                    Api.toggleFav(item)
                }.getOrNull()
            }
            if (on == null) {
                Toast.makeText(this@DetailActivity, "收藏失败，可能没开收藏权限", Toast.LENGTH_SHORT).show()
            } else {
                btnFav.text = if (on) "★ 已收藏" else "☆ 收藏"
                Toast.makeText(this@DetailActivity, if (on) "已收藏" else "已取消收藏", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
