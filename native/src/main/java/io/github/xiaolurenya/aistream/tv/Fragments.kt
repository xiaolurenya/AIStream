package io.github.xiaolurenya.aistream.tv

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.ConcatAdapter
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------- 首页：顶部海报轮播 + 下面按栏目竖着排，每栏横滑 ----------
class HomeFragment : Fragment(R.layout.fragment_home) {

    private lateinit var banner: BannerAdapter
    private lateinit var adapter: ColumnAdapter
    private val ui = Handler(Looper.getMainLooper())

    /* 轮播自动翻页。只在页面可见时跑，退后台就停，别在后台白耗电；
       用户手动滑走后也会顺延一个周期再自动翻 */
    private val rot = object : Runnable {
        override fun run() {
            banner.next()
            ui.postDelayed(this, ROT_MS)
        }
    }

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        val swipe = v.findViewById<SwipeRefreshLayout>(R.id.swipe)
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        rv.layoutManager = LinearLayoutManager(requireContext())
        banner = BannerAdapter { c -> DetailActivity.open(requireContext(), c) }
        adapter = ColumnAdapter { c -> DetailActivity.open(requireContext(), c) }
        // 海报栏是第 0 项，跟着列表一起滚，不长期占用屏幕高度
        rv.adapter = ConcatAdapter(banner, adapter)
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
       先排「推荐/最新/热门」这类栏目，按片名+年份去重，没海报的不要，取前 6 条。
       这样不管接的是采集站还是内置豆瓣源，装好就有轮播。 */
    private fun pickBanner(cols: List<Api.Column>): List<Api.Card> {
        val hot = Regex("推荐|最新|热门|热播|正在热|影视|电影|剧集|剧场")
        val ordered = cols.sortedByDescending { if (hot.containsMatchIn(it.label.orEmpty())) 1 else 0 }
        val seen = HashSet<String>()
        val out = mutableListOf<Api.Card>()
        for (col in ordered) {
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
            banner.submit(pickBanner(keep))
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
