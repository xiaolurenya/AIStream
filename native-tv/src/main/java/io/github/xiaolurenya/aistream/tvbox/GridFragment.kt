package io.github.xiaolurenya.aistream.tvbox

import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 搜索 / 收藏 / 历史：一个海报网格，TV 上一行 6 张
abstract class GridFragment : Fragment(R.layout.fragment_grid) {

    protected abstract val withSearch: Boolean
    protected abstract suspend fun fetch(q: String): List<Api.Card>

    private lateinit var adapter: PosterAdapter
    private lateinit var empty: TextView
    private var query = ""
    private var job: Job? = null

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        val et = v.findViewById<EditText>(R.id.etSearch)
        empty = v.findViewById(R.id.tvEmpty)

        rv.layoutManager = GridLayoutManager(requireContext(), resources.getInteger(R.integer.grid_cols))
        quickAnim(rv)
        adapter = PosterAdapter(mutableListOf()) { c -> DetailActivity.open(requireContext(), c) }
        rv.adapter = adapter

        if (withSearch) {
            et.visibility = View.VISIBLE
            et.setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                    query = et.text.toString().trim()
                    reload()
                    true
                } else false
            }
            // 遥控器/软键盘输入很慢，输完停顿 800ms 再搜，别打一个字发一次请求
            et.addTextChangedListener { s ->
                val q = s?.toString()?.trim().orEmpty()
                job?.cancel()
                job = viewLifecycleOwner.lifecycleScope.launch {
                    delay(800)
                    query = q
                    reload()
                }
            }
        } else {
            reload()
        }
    }

    protected fun reload() {
        viewLifecycleOwner.lifecycleScope.launch {
            val list = withContext(Dispatchers.IO) {
                runCatching { fetch(query) }.getOrDefault(emptyList())
            }
            adapter.submit(list)
            empty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
            empty.text = if (query.isBlank()) "这里还没有内容" else "没搜到「$query」"
        }
    }

    protected fun toast(s: String) {
        val c = context ?: return
        android.widget.Toast.makeText(c, s, android.widget.Toast.LENGTH_SHORT).show()
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
}

class HistoryFragment : GridFragment() {
    override val withSearch = false
    override suspend fun fetch(q: String): List<Api.Card> =
        Api.history().map { Api.Card(id = it.id, title = it.title, poster = it.poster, year = it.year) }
}
