package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 个人中心：账号 / 积分 / 会员 / 签到 / 会员兑换
class MeFragment : Fragment(R.layout.fragment_me) {

    private lateinit var tvUser: TextView
    private lateinit var tvVip: TextView
    private lateinit var tvPoints: TextView
    private lateinit var tvMsg: TextView

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        tvUser = v.findViewById(R.id.tvUser)
        tvVip = v.findViewById(R.id.tvVip)
        tvPoints = v.findViewById(R.id.tvPoints)
        tvMsg = v.findViewById(R.id.tvMsg)

        tvUser.text = Prefs.user.ifBlank { "未登录" }

        val btnCheckin = v.findViewById<TextView>(R.id.btnCheckin)
        val btnRedeem = v.findViewById<TextView>(R.id.btnRedeem)
        val btnSwitch = v.findViewById<TextView>(R.id.btnSwitch)
        val btnHero = v.findViewById<TextView>(R.id.btnHero)
        val btnMute = v.findViewById<TextView>(R.id.btnMute)
        bindFocus(btnCheckin)
        bindFocus(btnRedeem)
        bindFocus(btnSwitch)
        bindFocus(btnHero)
        bindFocus(btnMute)

        btnHero.text = heroText()
        btnHero.setOnClickListener {
            Prefs.heroLive = !Prefs.heroLive
            btnHero.text = heroText()
            toast(if (Prefs.heroLive) "首页打开就播直播了" else "首页打开显示海报了")
        }

        btnMute.text = muteText()
        btnMute.setOnClickListener {
            Prefs.iptvMute = !Prefs.iptvMute
            btnMute.text = muteText()
            toast(if (Prefs.iptvMute) "直播小窗已静音" else "直播小窗恢复有声")
        }

        btnCheckin.setOnClickListener { doCheckin() }
        btnRedeem.setOnClickListener { startActivity(Intent(requireContext(), RedeemActivity::class.java)) }
        btnSwitch.setOnClickListener {
            lifecycleScope.launch(Dispatchers.IO) { runCatching { Api.logout() } }
            Prefs.token = ""
            startActivity(Intent(requireContext(), SetupActivity::class.java))
            requireActivity().finish()
        }

        load()
    }

    private fun load() {
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.pointsMe() }.getOrNull() }
            if (r == null) {
                tvPoints.text = "积分信息取不到（可能没开积分权限）"
                return@launch
            }
            tvPoints.text = "积分 " + r.points.orEmpty() +
                " · 今日已看 " + (r.daily?.watchMin.orEmpty()) + " 分钟"
            val vip = r.vip
            tvVip.text = if (vip == null || vip.name.isNullOrBlank()) "普通用户"
            else {
                val exp = vip.expire.orEmpty()
                "会员：" + vip.name.orEmpty() + if (exp.isBlank()) "" else "（$exp 到期）"
            }
            btnCheckinText(r.checkin?.today == true)
        }
    }

    private fun heroText(): String =
        if (Prefs.heroLive) "首页打开时：直播" else "首页打开时：海报"

    private fun muteText(): String =
        if (Prefs.iptvMute) "直播小窗：静音" else "直播小窗：有声"

    private fun toast(s: String) =
        Toast.makeText(requireContext(), s, Toast.LENGTH_SHORT).show()

    private fun btnCheckinText(done: Boolean) {
        val b = view?.findViewById<TextView>(R.id.btnCheckin) ?: return
        b.text = if (done) "今天已签到" else "每日签到"
        b.alpha = if (done) 0.55f else 1f
    }

    private fun doCheckin() {
        tvMsg.text = "签到中…"
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.checkin() }.getOrNull() }
            when {
                r == null -> tvMsg.text = "签到失败，可能没开积分权限"
                r.ok -> {
                    tvMsg.text = "签到成功，+" + r.gained.orEmpty() + " 积分（连签 " + r.streak.orEmpty() + " 天）"
                    btnCheckinText(true)
                }
                else -> tvMsg.text = r.msg ?: r.error ?: "今天已经签过到了"
            }
        }
    }
}
