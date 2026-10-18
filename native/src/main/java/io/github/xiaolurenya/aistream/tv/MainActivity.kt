package io.github.xiaolurenya.aistream.tv

import android.content.Intent
import android.os.Bundle
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import com.google.android.material.bottomnavigation.BottomNavigationView

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 没配过站点（或清过凭证）直接回配置页
        if (!Prefs.configured) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        val pager = findViewById<ViewPager2>(R.id.pager)
        val nav = findViewById<BottomNavigationView>(R.id.nav)
        val tvTitle = findViewById<TextView>(R.id.tvTitle)
        val tvUser = findViewById<TextView>(R.id.tvUser)

        tvTitle.text = Prefs.siteName.ifBlank { getString(R.string.app_name) }
        tvUser.text = Prefs.user

        // 只允许底部导航切页：页面里还有横向栏目，左右滑动翻页会和它们抢手势
        pager.isUserInputEnabled = false
        pager.adapter = object : FragmentStateAdapter(this) {
            override fun getItemCount() = 5
            override fun createFragment(pos: Int) = when (pos) {
                0 -> HomeFragment()
                1 -> SearchFragment()
                2 -> IptvFragment()
                3 -> FavFragment()
                else -> MeFragment()
            }
        }

        nav.setOnItemSelectedListener {
            // false = 不做滑动补间：底部导航切页要的是立刻到位，
            // 那 300ms 的横滑动画在 Fragment 还没渲染完时反而是一段卡顿
            pager.setCurrentItem(when (it.itemId) {
                R.id.nav_home -> 0
                R.id.nav_search -> 1
                R.id.nav_iptv -> 2
                R.id.nav_fav -> 3
                else -> 4
            }, false)
            true
        }

        findViewById<TextView>(R.id.btnSetup).setOnClickListener {
            Prefs.token = ""
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
        }

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
}
