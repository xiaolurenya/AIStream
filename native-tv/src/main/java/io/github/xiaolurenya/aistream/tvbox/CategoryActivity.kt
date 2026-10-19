package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 顶部分类标签点进来：显示该栏目下全部海报的网格（对应界面到前面），D-pad 挑一张进详情。
   数据直接用 HomeFragment 已经拉好的 PlayCache.homeCols，不用再发一次请求。 */
class CategoryActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_IDX = "idx"
        // 传的是服务端栏目配置序号（不是客户端下标），翻页要按它
        fun open(ctx: Context, serverIdx: Int) {
            val i = Intent(ctx, CategoryActivity::class.java)
            i.putExtra(EXTRA_IDX, serverIdx)
            ctx.startActivity(i)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_category)

        val serverIdx = intent.getIntExtra(EXTRA_IDX, -1)
        // 用服务端配置序号定位栏目：首页过滤过空栏目，客户端下标已不对应服务端 idx
        val col = PlayCache.homeCols.firstOrNull { it.idx == serverIdx }
        // 栏目还没准备好（极少见：进页面时首页还没拉完）就直接回去，别白开一个空窗
        if (col == null) { finish(); return }

        val tvTitle = findViewById<TextView>(R.id.tvTitle)
        tvTitle.text = col.label.orEmpty().ifBlank { "栏目" }

        val rv = findViewById<RecyclerView>(R.id.recycler)
        // 列数按 poster_w 现算：让每格只比卡片宽 0~2 个间距，排出来是紧凑的海报墙
        rv.layoutManager = GridLayoutManager(this, posterSpanCount(this))
        // 网格间距统一走装饰（横 12 / 纵 16，横竖接近，不再一宽一窄）
        val dm = resources.displayMetrics.density
        rv.addItemDecoration(SpacesItemDecoration((12 * dm).toInt(), (16 * dm).toInt()))
        // 翻页要的是「瞬间出」：任何插入动画都只会让大哥觉得卡（图2 二次点击卡顿）
        noAnim(rv)
        val items = col.items.orEmpty().toMutableList()

        // 「显示更多」：网格末尾一张按钮卡，点了拉下一页，拉空自动收起。
        // v1.4.3 之前还有「滑到接近底部自动预拉」，结果按钮永远被新数据往下推，
        // 大哥翻到底也见不着「显示更多」（图1）——现在只认按钮，翻到末尾一定在
        var page = 1
        var loading = false
        var done = false
        // 预取缓存：进页面就先拉下一页存着；预取中不重复发同一条请求（图2 二次点击慢的根因）
        val pageCache = HashMap<Int, List<Api.Card>>()
        var prefetching = 0
        fun prefetch() {
            val target = page + 1
            if (done || pageCache.containsKey(target) || prefetching == target) return
            prefetching = target
            lifecycleScope.launch {
                val more = withContext(Dispatchers.IO) {
                    runCatching { Api.homeMore(col.idx, target) }.getOrDefault(emptyList())
                }
                if (more.isNotEmpty()) pageCache[target] = more
                prefetching = 0
            }
        }
        // 进页面先预取下一页，等用户点「显示更多」时多半已经躺在内存里了
        prefetch()

        // 焦点送到新增区第一张，遥控器接着往下挪不用回头找
        fun focusNew(from: Int) {
            val lm = rv.layoutManager as? GridLayoutManager
            rv.post {
                (lm ?: return@post).scrollToPosition(from)
                rv.postDelayed({
                    rv.findViewHolderForAdapterPosition(from)?.itemView?.requestFocus()
                }, 80)
            }
        }
        fun loadNext() {
            if (loading || done) return
            val ad = rv.adapter as? PosterAdapter ?: return
            loading = true
            ad.setMoreLabel("加载中…")
            val from = ad.itemCount - 1 // 新页第一张的下标（append 前最后一位是「显示更多」卡，它会让位到新页尾）
            lifecycleScope.launch {
                val target = page + 1
                // 预取正在拉这一页就等它落地（最多 5 秒），不再发第二条一样的请求
                var waited = 0
                while (prefetching == target && waited < 100) { delay(50); waited++ }
                val more = pageCache.remove(target) ?: withContext(Dispatchers.IO) {
                    runCatching { Api.homeMore(col.idx, target) }.getOrDefault(emptyList())
                }
                withContext(Dispatchers.Main) {
                    if (more.isEmpty()) { done = true; ad.setHasMore(false) }
                    else {
                        page = target
                        ad.append(more)
                        // 焦点送到新增区第一张，遥控器接着往下挪不用回头找
                        focusNew(from)
                    }
                    ad.setMoreLabel("显示更多")
                    loading = false
                    // 立刻接着预取下一页，连环点也是秒出
                    prefetch()
                }
            }
        }
        rv.adapter = PosterAdapter(items, { c ->
            // 选一张海报：进详情页（从那里直接播），跟首页/收藏/历史挑海报一个入口
            DetailActivity.open(this, c)
        }, { loadNext() })

        // 焦点先进第一行第一张，确认键直接进详情，不用先手动找
        rv.post { rv.getChildAt(0)?.requestFocus() }

        // 去掉进/出页面动画：之前「显示更多」弹出满屏要等动画，显得迟钝；直接切，跟首页选台一个节奏
        overridePendingTransition(0, 0)
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView)
            .hide(WindowInsetsCompat.Type.systemBars())
    }
}
