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
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView

/* 顶部分类标签点进来：显示该栏目下全部海报的网格（对应界面到前面），D-pad 挑一张进详情。
   数据直接用 HomeFragment 已经拉好的 PlayCache.homeCols，不用再发一次请求。 */
class CategoryActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_IDX = "idx"
        fun open(ctx: Context, idx: Int) {
            val i = Intent(ctx, CategoryActivity::class.java)
            i.putExtra(EXTRA_IDX, idx)
            ctx.startActivity(i)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_category)

        val idx = intent.getIntExtra(EXTRA_IDX, -1)
        val col = PlayCache.homeCols.getOrNull(idx)
        // 栏目还没准备好（极少见：进页面时首页还没拉完）就直接回去，别白开一个空窗
        if (col == null) { finish(); return }

        val tvTitle = findViewById<TextView>(R.id.tvTitle)
        tvTitle.text = col.label.orEmpty().ifBlank { "栏目" }

        val rv = findViewById<RecyclerView>(R.id.recycler)
        rv.layoutManager = GridLayoutManager(this, resources.getInteger(R.integer.grid_cols))
        quickAnim(rv)
        rv.adapter = PosterAdapter(col.items.orEmpty().toMutableList()) { c ->
            // 选一张海报：进详情页（从那里直接播），跟首页/收藏/历史挑海报一个入口
            DetailActivity.open(this, c)
        }

        // 焦点先进第一行第一张，确认键直接进详情，不用先手动找
        rv.post { rv.getChildAt(0)?.requestFocus() }
    }

    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView)
            .hide(WindowInsetsCompat.Type.systemBars())
    }
}
