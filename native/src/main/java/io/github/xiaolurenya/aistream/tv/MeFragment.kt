package io.github.xiaolurenya.aistream.tv

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 个人中心：账号信息 + 会员 + 积分 + 签到 + 邀请码 + 历史 + 兑换 + 改密 + 退出
class MeFragment : Fragment(R.layout.fragment_me) {

    private lateinit var tvUser: TextView
    private lateinit var tvVip: TextView
    private lateinit var tvPoints: TextView
    private lateinit var tvWatch: TextView
    private lateinit var btnSign: TextView
    private lateinit var btnInvite: TextView

    private var inviteCode = ""

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        tvUser = v.findViewById(R.id.tvUser)
        tvVip = v.findViewById(R.id.tvVip)
        tvPoints = v.findViewById(R.id.tvPoints)
        tvWatch = v.findViewById(R.id.tvWatch)
        btnSign = v.findViewById(R.id.btnSign)
        btnInvite = v.findViewById(R.id.btnInvite)

        tvUser.text = Prefs.user

        btnSign.setOnClickListener { doSign() }
        btnInvite.setOnClickListener { copyInvite() }
        v.findViewById<View>(R.id.btnHistory).setOnClickListener {
            startActivity(Intent(requireContext(), ListActivity::class.java).putExtra("mode", "history"))
        }
        v.findViewById<View>(R.id.btnRedeem).setOnClickListener {
            startActivity(Intent(requireContext(), RedeemActivity::class.java))
        }
        v.findViewById<View>(R.id.btnChangePw).setOnClickListener { showChangePw() }
        v.findViewById<View>(R.id.btnLogout).setOnClickListener { doLogout() }

        load()
    }

    private fun toast(s: String) {
        val c = context ?: return
        Toast.makeText(c, s, Toast.LENGTH_SHORT).show()
    }

    private fun load() {
        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.pointsMe() }.getOrNull() }
            if (r == null) {
                tvPoints.text = "积分信息读取失败"
                return@launch
            }
            val vip = r.vip
            tvVip.text = if ((vip?.level ?: "0") == "0") "普通用户" else (vip?.name ?: "会员")
            tvPoints.text = "积分 " + (r.points ?: "0")
            val wm = r.daily?.watchMin ?: "0"
            tvWatch.text = "今日已看 " + wm + " 分钟"

            inviteCode = r.invite?.code.orEmpty()
            btnInvite.text = if (inviteCode.isBlank()) "暂无邀请码" else "邀请码 " + inviteCode

            val done = r.checkin?.today == true
            btnSign.text = if (done) getString(R.string.points_signed) else getString(R.string.points_sign)
            btnSign.alpha = if (done) 0.5f else 1f
            if (done) btnSign.setOnClickListener { toast("今天已经签到过了") }
        }
    }

    private fun doSign() {
        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.checkin() }.getOrNull() }
            if (r?.ok == true) {
                toast(r.msg ?: ("签到成功 +" + (r.gained ?: "0")))
                btnSign.text = getString(R.string.points_signed)
                btnSign.alpha = 0.5f
                load()
            } else {
                toast(r?.error ?: "签到失败")
            }
        }
    }

    private fun copyInvite() {
        if (inviteCode.isBlank()) { toast("这个站点没给你开邀请码"); return }
        val c = context ?: return
        val cm = c.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
        cm.setPrimaryClip(ClipData.newPlainText("invite", inviteCode))
        toast("邀请码已复制：" + inviteCode)
    }

    private fun showChangePw() {
        val c = context ?: return
        val box = LinearLayout(c).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 20, 40, 0)
        }
        val oldPw = EditText(c).apply {
            hint = "当前密码"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val newPw = EditText(c).apply {
            hint = "新密码（至少 6 位）"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        box.addView(oldPw)
        box.addView(newPw)

        AlertDialog.Builder(c)
            .setTitle(R.string.act_change_pw)
            .setView(box)
            .setNegativeButton("取消", null)
            .setPositiveButton("确定") { _, _ ->
                val o = oldPw.text.toString()
                val n = newPw.text.toString()
                if (n.length < 6) { toast("新密码至少 6 位"); return@setPositiveButton }
                lifecycleScope.launch {
                    val ok = withContext(Dispatchers.IO) {
                        runCatching { Api.changePassword(o, n); true }.getOrDefault(false)
                    }
                    if (ok) {
                        Prefs.pass = n
                        toast("密码已修改，下次登录用新密码")
                    } else toast("修改失败，检查当前密码对不对")
                }
            }
            .show()
    }

    private fun doLogout() {
        val c = context ?: return
        AlertDialog.Builder(c)
            .setTitle(R.string.act_logout)
            .setMessage("退出后要重新填账号密码才能进，确定吗？")
            .setNegativeButton("取消", null)
            .setPositiveButton("退出") { _, _ ->
                lifecycleScope.launch(Dispatchers.IO) { runCatching { Api.logout() } }
                Prefs.token = ""
                startActivity(Intent(requireContext(), SetupActivity::class.java))
                requireActivity().finish()
            }
            .show()
    }
}
