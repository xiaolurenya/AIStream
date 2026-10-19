package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.appcompat.app.AlertDialog
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
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

    private val nav = mutableListOf<View>()
    private var cur = -1

    private class RailItem(val icon: String, val title: String, val sub: String, val bg: Int)

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

        // 左侧功能卡 + 快捷卡同款：竖排两行（图标+标题 / 副标题），整体居中。
        // 之前副标题塞在一个 Html <small> 里又小又糊还贴顶，大哥看了骂；现在两行都清楚且居中。
        fun mkRailCard(
            icon: String, title: String, sub: String, bg: Int,
            onClick: () -> Unit, onFocus: ((Boolean) -> Unit)? = null, topMarginDp: Int = 10
        ): LinearLayout {
            val dm = resources.displayMetrics.density
            val pad = (resources.getDimensionPixelSize(R.dimen.nav_pad) * 1.5f).toInt()
            return LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = android.view.Gravity.CENTER
                setBackgroundResource(bg)
                isFocusable = true
                isFocusableInTouchMode = true
                // 卡片自身也关裁剪：两行文字 + 焦点白描边在 1.06 放大时不会再被卡片边界切掉（图1 选中显示不全根因）
                clipChildren = false
                setPadding(pad, (8 * dm).toInt(), pad, (8 * dm).toInt())
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, (76 * dm).toInt()
                ).apply { topMargin = (topMarginDp * dm).toInt() }
                addView(TextView(this@MainActivity).apply {
                    text = icon + "  " + title
                    gravity = android.view.Gravity.CENTER
                    setTextColor(getColor(R.color.fg))
                    setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, resources.getDimension(R.dimen.side_card_text))
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                })
                addView(TextView(this@MainActivity).apply {
                    text = sub
                    gravity = android.view.Gravity.CENTER
                    setTextColor(0xFFC9D6EC.toInt())
                    setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, resources.getDimension(R.dimen.side_sub_text))
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply { topMargin = (4 * dm).toInt() }
                })
                bindFocus(this) { h -> onFocus?.invoke(h) }
                setOnClickListener { onClick() }
            }
        }

        RAIL.forEachIndexed { i, item ->
            val card = mkRailCard(
                item.icon, item.title, item.sub, item.bg,
                onClick = { if (i == RAIL_LIVE) openLive() else switch(i) },
                onFocus = { if (i == RAIL_LIVE) home()?.onLiveFocus(it) },
                topMarginDp = if (i == 0) 0 else 10
            )
            rail.addView(card)
            nav.add(card)
        }

        // 签到/兑换：跟上面 4 张卡同一个家族，排在「观看历史」下面（大哥指定挪过来）
        rail.addView(mkRailCard("📮", "每日签到", "点击领取积分", R.drawable.bg_side_his,
            onClick = { doCheckin() }, topMarginDp = 12))
        rail.addView(mkRailCard("🎁", "会员兑换", "积分换会员权益", R.drawable.bg_side_live,
            onClick = { startActivity(Intent(this, RedeemActivity::class.java)) }, topMarginDp = 10))

        findViewById<TextView>(R.id.btnSearch).apply {
            bindFocus(this)
            setOnClickListener { switch(SEARCH) }
        }
        findViewById<TextView>(R.id.btnMe).apply {
            bindFocus(this)
            setOnClickListener { switch(ME) }
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

    private fun doCheckin() {
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.checkin() }.getOrNull() }
            when {
                r == null -> toast("签到失败，可能没开积分权限")
                r.ok -> toast("签到成功，+" + r.gained.orEmpty() + " 积分（连签 " + r.streak.orEmpty() + " 天）")
                else -> toast(r.msg ?: r.error ?: "今天已经签过到了")
            }
        }
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

    // 退到首页再按返回键才退出，别一不小心就把 APP 关了。
    // 首页直播预览小窗开着时，第一下返回先收小窗（焦点给「首页」卡——
    // 不能给「电视直播」卡，它一聚焦又会把小窗弹回来），再按才退出
    override fun onBackPressed() {
        if (cur == RAIL_HOME && home()?.previewShowing() == true) {
            home()?.onLiveFocus(false)
            nav.getOrNull(RAIL_HOME)?.requestFocus()
            return
        }
        if (cur != RAIL_HOME) {
            switch(RAIL_HOME)
            nav.getOrNull(RAIL_HOME)?.requestFocus()
        } else {
            super.onBackPressed()
        }
    }

    companion object {
        // 顺序即左侧卡顺序（图1 样式，加了张「首页」卡回主内容）
        private val RAIL = listOf(
            RailItem("🏠", "首页", "为你推荐", R.drawable.bg_side_home),
            RailItem("❤", "我的收藏", "精选优质影视剧", R.drawable.bg_side_fav),
            RailItem("📺", "电视直播", "央视卫视在线直播", R.drawable.bg_side_live),
            RailItem("⏱", "观看历史", "接着上次的看", R.drawable.bg_side_his)
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
