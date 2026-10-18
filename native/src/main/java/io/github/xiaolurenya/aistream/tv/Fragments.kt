package io.github.xiaolurenya.aistream.tv

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.viewpager2.widget.ViewPager2
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------- 首页：顶部海报轮播 + 下面按栏目竖着排，每栏横滑 ----------
class HomeFragment : Fragment(R.layout.fragment_home) {

    private lateinit var adapter: ColumnAdapter
    private lateinit var bannerBox: View
    private lateinit var bannerPager: ViewPager2
    private lateinit var dots: LinearLayout
    private val ui = Handler(Looper.getMainLooper())
    private var cur = 0
    // 所有栏目行共用的 ViewHolder 回收池
    private val sharedPool = RecyclerView.RecycledViewPool()

    /* 轮播自动翻页。只在页面可见时跑，退后台就停，别在后台白耗电。
       翻页这一步整体包在 runCatching 里：轮播只是锦上添花，
       出任何岔子都不能把整个首页拖崩。 */
    private val rot = object : Runnable {
        override fun run() {
            runCatching {
                val n = bannerPager.adapter?.itemCount ?: 0
                if (n > 1) {
                    cur = (cur + 1) % n
                    bannerPager.setCurrentItem(cur, true)
                }
            }.onFailure { Log.w("aistream", "banner next: " + it.message) }
            ui.postDelayed(this, ROT_MS)
        }
    }

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        val swipe = v.findViewById<SwipeRefreshLayout>(R.id.swipe)
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        bannerBox = v.findViewById(R.id.bannerBox)
        bannerPager = v.findViewById(R.id.banner)
        dots = v.findViewById(R.id.bannerDots)

        rv.layoutManager = LinearLayoutManager(requireContext())
        quickAnim(rv)
        adapter = ColumnAdapter({ c -> DetailActivity.open(requireContext(), c) }, sharedPool)
        rv.adapter = adapter

        // 海报栏直接挂在页面顶部，不塞进 RecyclerView，省掉嵌套滑动的麻烦
        bannerPager.adapter = BannerPageAdapter { c -> DetailActivity.open(requireContext(), c) }
        // 相邻两页先渲染好，滑到下一张不会先空一下
        bannerPager.offscreenPageLimit = 2
        // 翻页时整页轻微缩放+淡入：比默认的硬切看着顺，也不拖时间
        bannerPager.setPageTransformer { page, pos ->
            val k = 1f - kotlin.math.abs(pos) * 0.12f
            page.alpha = 0.65f + 0.35f * k
            page.scaleX = k
            page.scaleY = k
        }
        bannerPager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(p: Int) { cur = p; paintDots() }
        })

        swipe.setOnRefreshListener { load(swipe) }
        load(swipe)
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

    /* 轮播内容自动挑，不占后台配置项：
       严格按服务器首页返回的栏目顺序取（第一栏最优先），按「片名+年份」去重，
       没海报的不要，取前 6 条。这样每个人看到的就是「他自己首页排最前的那些推荐」，
       服务端首页配了什么、排了什么顺序，APP 就跟着来，不做任何本地重排。 */
    private fun pickBanner(cols: List<Api.Column>): List<Api.Card> {
        val seen = HashSet<String>()
        val out = mutableListOf<Api.Card>()
        for (col in cols) {
            for (c in col.items.orEmpty()) {
                val key = c.title.orEmpty().trim() + "|" + c.year.orEmpty().trim()
                if (!seen.add(key)) continue
                if (Api.dimg(c.poster).isBlank()) continue
                out.add(c)
                if (out.size >= BANNER_MAX) return out
            }
        }
        return out
    }

    private fun load(swipe: SwipeRefreshLayout) {
        swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val cols = withContext(Dispatchers.IO) {
                runCatching { Api.home()?.columns.orEmpty() }.getOrDefault(emptyList())
            }
            swipe.isRefreshing = false
            // 空栏目不占位：配了采集站但没内容时首页不该出现一堆空标题
            val keep = cols.filter { !it.items.isNullOrEmpty() }
            adapter.submit(keep)

            val picks = pickBanner(keep)
            val pg = bannerPager.adapter as? BannerPageAdapter
            if (pg != null && picks.isNotEmpty()) {
                pg.submit(picks)
                bannerBox.visibility = View.VISIBLE
                paintDots()
            } else {
                bannerBox.visibility = View.GONE
            }
        }
    }

    // 轮播下面的小圆点：当前页那颗拉长成小横条
    private fun paintDots() {
        val n = bannerPager.adapter?.itemCount ?: 0
        dots.removeAllViews()
        if (n <= 1) return
        val ctx = dots.context
        val dm = ctx.resources.displayMetrics.density
        for (k in 0 until n) {
            val d = View(ctx)
            val w = ((if (k == cur) 16 else 6) * dm).toInt()
            val h = (6 * dm).toInt()
            val lp = LinearLayout.LayoutParams(w, h)
            lp.marginEnd = (5 * dm).toInt()
            d.layoutParams = lp
            d.setBackgroundResource(if (k == cur) R.drawable.dot_on else R.drawable.dot_off)
            dots.addView(d)
        }
    }

    private companion object {
        const val ROT_MS = 5000L   // 轮播间隔
        const val BANNER_MAX = 6   // 最多轮播几条
    }
}

// ---------- 网格页基类：搜索 / 收藏 / 历史都长一个样 ----------
abstract class GridFragment : Fragment(R.layout.fragment_grid) {

    protected abstract val withSearch: Boolean
    protected abstract suspend fun fetch(q: String): List<Api.Card>

    private lateinit var adapter: PosterAdapter
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var empty: TextView
    private var query = ""
    private var job: Job? = null

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        swipe = v.findViewById(R.id.swipe)
        empty = v.findViewById(R.id.tvEmpty)
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        val et = v.findViewById<EditText>(R.id.etSearch)
        rv.layoutManager = GridLayoutManager(requireContext(), 3)
        quickAnim(rv)
        adapter = PosterAdapter(
            mutableListOf(),
            { c -> DetailActivity.open(requireContext(), c) },
            { c -> remove(c) }
        )
        rv.adapter = adapter
        swipe.setOnRefreshListener { reload() }

        if (withSearch) {
            et.visibility = View.VISIBLE
            et.addTextChangedListener { s ->
                val q = s?.toString()?.trim().orEmpty()
                job?.cancel()
                job = viewLifecycleOwner.lifecycleScope.launch {
                    delay(420)
                    query = q
                    reload()
                }
            }
        } else {
            reload()
        }
    }

    protected fun reload() {
        swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val list = withContext(Dispatchers.IO) {
                runCatching { fetch(query) }.getOrDefault(emptyList())
            }
            swipe.isRefreshing = false
            adapter.submit(list)
            empty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
        }
    }

    // 长按删除：收藏和历史才有意义，搜索页空实现
    protected open fun remove(c: Api.Card) {}

    protected fun toast(s: String) {
        val c: Context? = context
        if (c != null) Toast.makeText(c, s, Toast.LENGTH_SHORT).show()
    }
}

class SearchFragment : GridFragment() {
    override val withSearch = true
    override suspend fun fetch(q: String): List<Api.Card> {
        if (q.isBlank()) return emptyList()
        val r = Api.search(q) ?: return emptyList()
        val out = mutableListOf<Api.Card>()
        r.tmdb.orEmpty().forEach { out.add(it) }
        // 采集站结果带上站点 id：进详情页能用「站点 id + 站内 id」精确取源，不靠站方搜索
        r.collect.orEmpty().forEach { v ->
            out.add(
                Api.Card(
                    id = v.id, title = v.name, poster = v.poster, year = v.year,
                    media = "collect", station = v.stationId, score = v.remark
                )
            )
        }
        return out
    }
}

class FavFragment : GridFragment() {
    override val withSearch = false
    override suspend fun fetch(q: String): List<Api.Card> =
        Api.favs().map { Api.Card(id = it.id, title = it.title, poster = it.poster, year = it.year) }

    override fun remove(c: Api.Card) {
        val id = c.id.orEmpty()
        if (id.isBlank()) return
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { Api.postRaw("/api/fav", Api.gsonText(mapOf("del" to id))) }.isSuccess
            }
            toast(if (ok) "已取消收藏" else "操作失败，可能没开收藏权限")
            reload()
        }
    }
}

class HistoryFragment : GridFragment() {
    override val withSearch = false
    override suspend fun fetch(q: String): List<Api.Card> =
        Api.history().map { Api.Card(id = it.id, title = it.title, poster = it.poster, year = it.year) }

    override fun remove(c: Api.Card) {
        val id = c.id.orEmpty()
        if (id.isBlank()) return
        viewLifecycleOwner.lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { Api.delHistory(id) }.isSuccess
            }
            toast(if (ok) "已删除这条记录" else "删除失败")
            reload()
        }
    }
}
