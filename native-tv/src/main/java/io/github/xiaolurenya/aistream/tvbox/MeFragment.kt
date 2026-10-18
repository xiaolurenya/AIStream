package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
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
        bindFocus(btnCheckin) { has -> btnCheckin.alpha = if (has) 1f else 0.9f }
        bindFocus(btnRedeem) { has -> btnRedeem.alpha = if (has) 1f else 0.9f }
        bindFocus(btnSwitch) { has -> btnSwitch.alpha = if (has) 1f else 0.9f }

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
