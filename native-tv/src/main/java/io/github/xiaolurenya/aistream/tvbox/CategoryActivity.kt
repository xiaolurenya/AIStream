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
        // 网格行间距：海报卡自带左右内边距撑开横向间隙，这里补纵向间隙，行不再贴在一起
        rv.addItemDecoration(SpacesItemDecoration(0, (16 * resources.displayMetrics.density).toInt()))
        quickAnim(rv)
        val items = col.items.orEmpty().toMutableList()
        rv.adapter = PosterAdapter(items) { c ->
            // 选一张海报：进详情页（从那里直接播），跟首页/收藏/历史挑海报一个入口
            DetailActivity.open(this, c)
        }

        // 焦点先进第一行第一张，确认键直接进详情，不用先手动找
        rv.post { rv.getChildAt(0)?.requestFocus() }

        // 纵向「显示更多」：滑到接近底部自动拉下一页，拉满后停止（避免重复请求）
        var page = 1
        var loading = false
        var done = false
        rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                val lm = rv.layoutManager as? GridLayoutManager ?: return
                val ad = rv.adapter as? PosterAdapter ?: return
                if (loading || done) return
                // 还剩不到两行就预拉下一页（D-pad 往下挪时无缝衔接）
                if (lm.findLastVisibleItemPosition() >= ad.itemCount - lm.spanCount * 2) {
                    loading = true
                    lifecycleScope.launch {
                        val more = withContext(Dispatchers.IO) {
                            runCatching { Api.homeMore(col.idx, page + 1) }.getOrDefault(emptyList())
                        }
                        withContext(Dispatchers.Main) {
                            if (more.isEmpty()) done = true
                            else { page++; ad.append(more) }
                            loading = false
                        }
                    }
                }
            }
        })
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView)
            .hide(WindowInsetsCompat.Type.systemBars())
    }
}
