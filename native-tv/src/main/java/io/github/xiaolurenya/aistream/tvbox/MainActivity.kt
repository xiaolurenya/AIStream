package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment

/* TV 主界面：左边导航轨 + 右边内容区。
   遥控器左右键在「导航轨 ↔ 内容」之间跳，上下键在各自内部移动，确认键进详情页。 */
class MainActivity : AppCompatActivity() {

    private val nav = mutableListOf<TextView>()
    private var cur = -1

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Prefs.configured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        val rail = findViewById<LinearLayout>(R.id.rail)
        findViewById<TextView>(R.id.tvBrand).text =
            Prefs.siteName.ifBlank { getString(R.string.app_name) }

        NAV.forEachIndexed { i, label ->
            val tv = TextView(this).apply {
                text = label
                textSize = 16f
                setTextColor(getColor(R.color.fg_dim))
                // 13dp：6 个导航项在 1080p 电视上一屏放得下，不会像上一版那样最后一条被截掉
                val pad = (13 * resources.displayMetrics.density).toInt()
                setPadding(pad, pad, pad, pad)
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                )
                isFocusable = true
                isFocusableInTouchMode = true
                // 上下键在导航轨内部移动是系统默认行为，这里只管选中态和点击
                setOnFocusChangeListener { _, has ->
                    setBackgroundColor(if (has) getColor(R.color.bg_card_hi) else 0)
                    setTextColor(getColor(if (has) R.color.fg else R.color.fg_dim))
                }
                setOnClickListener { switch(i) }
            }
            rail.addView(tv)
            nav.add(tv)
        }

        switch(0)
    }

    private fun switch(pos: Int) {
        if (pos == cur) return
        cur = pos
        nav.forEachIndexed { i, tv ->
            val on = i == pos
            tv.setBackgroundColor(if (on) getColor(R.color.bg_card_hi) else 0)
            tv.setTextColor(getColor(if (on) R.color.accent_soft else R.color.fg_dim))
        }
        val f: Fragment = when (pos) {
            0 -> HomeFragment()
            1 -> SearchFragment()
            2 -> IptvFragment()
            3 -> FavFragment()
            4 -> HistoryFragment()
            else -> MeFragment()
        }
        supportFragmentManager.beginTransaction()
            .replace(R.id.content, f)
            .commitAllowingStateLoss()
    }

    // 退到首页再按返回键才退出，别一不小心就把 APP 关了
    override fun onBackPressed() {
        if (cur != 0) {
            switch(0)
            nav.getOrNull(0)?.requestFocus()
        } else {
            super.onBackPressed()
        }
    }

    companion object {
        val NAV = listOf("首页", "搜索", "直播", "收藏", "历史", "我的")
    }
}
