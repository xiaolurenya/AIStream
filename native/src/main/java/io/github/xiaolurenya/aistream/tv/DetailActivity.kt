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
    private var lineIdx = 0
    private var epIdx = 0

    private lateinit var rvLines: RecyclerView
    private lateinit var rvEps: RecyclerView
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
        tvPlot = findViewById(R.id.tvPlot)
        labEps = findViewById(R.id.labEps)
        btnFav = findViewById(R.id.btnFav)

        findViewById<TextView>(R.id.btnBack).setOnClickListener { finish() }
        findViewById<TextView>(R.id.tvTitle).text = title
        findViewById<TextView>(R.id.tvMeta).text = year
        val u = Api.dimg(inPoster)
        if (u.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(u)

        rvLines.layoutManager = LinearLayoutManager(this, LinearLayoutManager.HORIZONTAL, false)
        rvEps.layoutManager = GridLayoutManager(this, 4)

        btnFav.setOnClickListener { toggleFav() }

        load()
    }

    private fun load() {
        lifecycleScope.launch {
            val resp = withContext(Dispatchers.IO) {
                // 有「站点 id + 站内 id」就精确取；只有片名就走全网聚合搜索
                if (inSid.isNotBlank() && inId.isNotBlank()) {
                    runCatching { Api.playByVid(inSid, inId) }.getOrNull()
                        ?.takeIf { !it.results.isNullOrEmpty() }
                        ?: runCatching { Api.playByName(title, year) }.getOrNull()
                } else {
                    runCatching { Api.playByName(title, year) }.getOrNull()
                }
            }

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

            PlayCache.parseList = resp.parseList.orEmpty()
            PlayCache.hasParse = resp.hasParse
            PlayCache.title = title
            PlayCache.year = year
            // 豆瓣卡的 db_ 前缀 id 只在本站首页有意义，存进历史/收藏会和网页端对不上，统一换成合成 id
            PlayCache.itemId = if (inId.isNotBlank() && !inId.startsWith("db_")) inId
            else PlayCache.synthId(title, year)

            val best = results.firstOrNull { !it.poster.isNullOrBlank() }
            PlayCache.poster = (best?.poster ?: inPoster).orEmpty()
            val pu = Api.dimg(PlayCache.poster)
            if (pu.isNotBlank()) findViewById<ImageView>(R.id.imgPoster).load(pu)

            val first = results.first()
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
            lines = flat
            if (lines.isEmpty()) {
                labEps.text = "暂无分集"
                return@launch
            }

            PlayCache.lines = lines
            paint()
        }
    }

    private fun paint() {
        val names = lines.map { "${it.station} · ${it.from} (${it.eps.size})" }
        rvLines.adapter = ChipAdapter(names, { lineIdx }) { i ->
            lineIdx = i
            epIdx = 0
            rvLines.adapter?.notifyDataSetChanged()
            paintEps()
        }
        labEps.text = "选集（共 ${lines[lineIdx].eps.size} 集）"
        paintEps()

        findViewById<TextView>(R.id.btnPlay).setOnClickListener { startPlayer() }
    }

    private fun paintEps() {
        val eps = lines[lineIdx].eps
        val names = eps.mapIndexed { i, e -> e.name ?: "第${i + 1}集" }
        rvEps.adapter = ChipAdapter(names, { epIdx }) { i ->
            epIdx = i
            startPlayer()
        }
    }

    private fun startPlayer() {
        if (lines.isEmpty()) {
            Toast.makeText(this, "没有可用线路", Toast.LENGTH_SHORT).show()
            return
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
