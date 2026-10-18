package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
                // 字号/内边距走 dimen：手机上装 TV 版自动用小一号（sw 分档）
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    resources.getDimension(R.dimen.nav_text))
                setTextColor(getColor(R.color.fg_dim))
                val pad = resources.getDimensionPixelSize(R.dimen.nav_pad)
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

    // 首页功能卡（收藏/历史）也跳这里，所以不能是 private
    fun switch(pos: Int) {
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

    // 沉浸式：TV 上没差别，但 TV 版装在手机上时能把底部手势条让出来（图1 底部那条白）
    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
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
