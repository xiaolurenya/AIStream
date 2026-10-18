package io.github.xiaolurenya.aistream.tvbox

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 首页：顶部一张自动轮换的大海报（hero），下面按栏目一行行竖着排。
   hero 用的是海报原图 + 左侧渐变压暗，不做任何模糊 —— TV 版要的就是清晰。 */
class HomeFragment : Fragment(R.layout.fragment_home) {

    private lateinit var adapter: ColumnAdapter
    private lateinit var hero: View
    private lateinit var heroBg: ImageView
    private lateinit var heroTitle: TextView
    private lateinit var heroMeta: TextView
    private lateinit var dots: LinearLayout
    private val ui = Handler(Looper.getMainLooper())
    private var picks = listOf<Api.Card>()
    private var cur = 0

    // 只在页面可见时轮换，退后台就停，别在后台白耗电
    private val rot = object : Runnable {
        override fun run() {
            runCatching {
                if (picks.size > 1) {
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
        heroTitle = v.findViewById(R.id.heroTitle)
        heroMeta = v.findViewById(R.id.heroMeta)
        dots = v.findViewById(R.id.heroDots)
        val rv = v.findViewById<RecyclerView>(R.id.recycler)

        rv.layoutManager = LinearLayoutManager(requireContext())
        quickAnim(rv)
        adapter = ColumnAdapter { c -> openDetail(c) }
        rv.adapter = adapter

        val btnPlay = v.findViewById<TextView>(R.id.btnPlay)
        bindFocus(btnPlay) { has -> btnPlay.alpha = if (has) 1f else 0.92f }
        btnPlay.setOnClickListener {
            picks.getOrNull(cur)?.let { openDetail(it) }
        }

        load()
    }

    override fun onResume() {
        super.onResume()
        ui.removeCallbacks(rot)
        ui.postDelayed(rot, ROT_MS)
    }

    override fun onPause() {
        ui.removeCallbacks(rot)
        super.onPause()
    }

    override fun onDestroyView() {
        ui.removeCallbacks(rot)
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
            adapter.submit(keep)

            picks = pickBanner(keep)
            if (picks.isEmpty()) {
                hero.visibility = View.GONE
            } else {
                hero.visibility = View.VISIBLE
                cur = 0
                paintHero()
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

    private companion object {
        const val ROT_MS = 6000L   // hero 轮换间隔
        const val HERO_MAX = 6     // 最多轮换几条
    }
}
