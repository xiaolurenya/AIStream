package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import android.text.Html
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.fragment.app.Fragment

/* TV 主界面：顶部品牌栏（logo + 搜索 + 我的）+ 左侧彩色功能卡导航轨 + 右侧内容区。
   左侧那三张彩色卡（图1）从首页里提上来常驻，替换原来那排纯文字菜单 ——
   遥控器/手指都只在这里切换页面；「电视直播」卡聚焦时首页 hero 还会出直播小窗预览，
   确认键直接全屏。 */
class MainActivity : AppCompatActivity() {

    private val nav = mutableListOf<TextView>()
    private var cur = -1

    private class RailItem(val label: String, val bg: Int)

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

        RAIL.forEachIndexed { i, item ->
            val tv = TextView(this).apply {
                // 副文案小字号：label 里已带 <br/><small>（图1 样式）
                text = Html.fromHtml(item.label, Html.FROM_HTML_MODE_LEGACY)
                // 字号/内边距走 dimen：手机上装 TV 版自动用小一号（sw 分档）
                setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX,
                    resources.getDimension(R.dimen.side_card_text))
                setTextColor(getColor(R.color.fg))
                setBackgroundResource(item.bg)
                isFocusable = true
                isFocusableInTouchMode = true
                val pad = resources.getDimensionPixelSize(R.dimen.nav_pad)
                setPadding(pad, pad, pad, pad)
                // 扁横排固定高（参考 base.apk）：weight 撑满会把卡撑成大色块，又空又蠢
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    (76 * resources.displayMetrics.density).toInt()
                ).apply {
                    if (i > 0) topMargin = (10 * resources.displayMetrics.density).toInt()
                }
                gravity = android.view.Gravity.CENTER_VERTICAL
                bindFocus(this)
                // 「电视直播」卡聚焦 → 首页 hero 出直播小窗预览（防抖在 fragment 里做）
                if (i == RAIL_LIVE) {
                    setOnFocusChangeListener { _, has -> home()?.onLiveFocus(has) }
                }
                setOnClickListener {
                    if (i == RAIL_LIVE) openLive() else switch(i)
                }
            }
            rail.addView(tv)
            nav.add(tv)
        }

        findViewById<TextView>(R.id.btnSearch).apply {
            bindFocus(this)
            setOnClickListener { switch(SEARCH) }
        }
        findViewById<TextView>(R.id.btnMe).apply {
            bindFocus(this)
            setOnClickListener { switch(ME) }
        }

        // 导航轨底部快捷区：扁横排两个小 chip（签到 | 兑换）。
        // 「首页直播开关」撤了 —— 跟功能卡里的「首页」重复，放「我的」页
        val btnQuickCheckin = findViewById<TextView>(R.id.btnQuickCheckin)
        val btnQuickRedeem = findViewById<TextView>(R.id.btnQuickRedeem)
        bindFocus(btnQuickCheckin)
        bindFocus(btnQuickRedeem)
        btnQuickRedeem.setOnClickListener { startActivity(Intent(this, RedeemActivity::class.java)) }
        btnQuickCheckin.setOnClickListener {
            btnQuickCheckin.isEnabled = false
            lifecycleScope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { Api.checkin() }.getOrNull() }
                btnQuickCheckin.isEnabled = true
                when {
                    r == null -> toast("签到失败，可能没开积分权限")
                    r.ok -> toast("签到成功，+" + r.gained.orEmpty() + " 积分（连签 " + r.streak.orEmpty() + " 天）")
                    else -> toast(r.msg ?: r.error ?: "今天已经签过到了")
                }
            }
        }

        switch(RAIL_HOME)

        // 实时推送：后台广播/公告（跟网页版同一通道）
        Notify.start(lifecycleScope) { t, c -> showPush(t, c) }
        // 兜底：启动时拉一次公告（网页版每次进页面都会弹，APP 之前漏了这条）
        Notify.fetchAnnouncement(lifecycleScope) { t, c -> showPush(t, c) }
    }

    private fun showPush(title: String, content: String) {
        runCatching {
            AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(if (content.isBlank()) "（无正文）" else content)
                .setPositiveButton("知道了", null)
                .show()
        }
    }

    override fun onDestroy() {
        Notify.stop()
        super.onDestroy()
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()

    // 沉浸式：TV 上没差别，但 TV 版装在手机上时能把底部手势条让出来（图1 底部那条白）
    override fun onResume() {
        super.onResume()
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun home(): HomeFragment? =
        supportFragmentManager.findFragmentById(R.id.content) as? HomeFragment

    private fun openLive() {
        // 频道还没拉过就先切到直播列表页（那里会拉），拉到了就直接全屏
        if (PlayCache.iptv.isEmpty()) {
            switch(RAIL_LIVE_PLACEHOLDER)
            return
        }
        startActivity(Intent(this, LiveActivity::class.java))
    }

    fun switch(pos: Int) {
        if (pos == cur) return
        cur = pos
        nav.forEachIndexed { i, tv ->
            val on = i == pos
            tv.elevation = if (on) 14f else 0f
            tv.alpha = if (on) 1f else 0.85f
        }
        val f: Fragment = when (pos) {
            RAIL_HOME -> HomeFragment()
            RAIL_FAV -> FavFragment()
            RAIL_HIS -> HistoryFragment()
            SEARCH -> SearchFragment()
            ME -> MeFragment()
            else -> IptvFragment()
        }
        supportFragmentManager.beginTransaction()
            .replace(R.id.content, f)
            .commitAllowingStateLoss()
    }

    // 退到首页再按返回键才退出，别一不小心就把 APP 关了
    override fun onBackPressed() {
        if (cur != RAIL_HOME) {
            switch(RAIL_HOME)
            nav.getOrNull(RAIL_HOME)?.requestFocus()
        } else {
            super.onBackPressed()
        }
    }

    companion object {
        // 顺序即左侧卡顺序（图1 样式，加了张「首页」卡回主内容）
        private fun sub(s: String) = "<br/><small><font color=\"#E6E9F2\">$s</font></small>"
        private val RAIL = listOf(
            RailItem("🏠 首页" + sub("为你推荐"), R.drawable.bg_side_home),
            RailItem("❤ 我的收藏" + sub("精选优质影视剧"), R.drawable.bg_side_fav),
            RailItem("📺 电视直播" + sub("央视卫视在线直播"), R.drawable.bg_side_live),
            RailItem("⏱ 观看历史" + sub("接着上次的看"), R.drawable.bg_side_his)
        )
        private const val RAIL_HOME = 0
        private const val RAIL_FAV = 1
        private const val RAIL_LIVE = 2
        private const val RAIL_HIS = 3
        // 直播卡在「频道还没拉过」时落到直播列表页
        private const val RAIL_LIVE_PLACEHOLDER = 7
        private const val SEARCH = 8
        private const val ME = 9
    }
}
