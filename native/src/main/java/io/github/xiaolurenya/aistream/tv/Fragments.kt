package io.github.xiaolurenya.aistream.tv

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ---------- 首页：按栏目竖着排，每栏横滑 ----------
class HomeFragment : Fragment(R.layout.fragment_home) {

    private lateinit var adapter: ColumnAdapter

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        val swipe = v.findViewById<SwipeRefreshLayout>(R.id.swipe)
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        rv.layoutManager = LinearLayoutManager(requireContext())
        adapter = ColumnAdapter { c -> DetailActivity.open(requireContext(), c) }
        rv.adapter = adapter
        swipe.setOnRefreshListener { load(swipe) }
        load(swipe)
    }

    private fun load(swipe: SwipeRefreshLayout) {
        swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val cols = withContext(Dispatchers.IO) {
                runCatching { Api.home()?.columns.orEmpty() }.getOrDefault(emptyList())
            }
            swipe.isRefreshing = false
            // 空栏目不占位：配了采集站但没内容时首页不该出现一堆空标题
            adapter.submit(cols.filter { !it.items.isNullOrEmpty() })
        }
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
