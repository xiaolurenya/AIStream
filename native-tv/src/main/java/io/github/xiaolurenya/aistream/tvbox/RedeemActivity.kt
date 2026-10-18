package io.github.xiaolurenya.aistream.tvbox

import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 会员兑换：积分换会员/权限，确认键兑换
class RedeemActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_redeem)

        val rv = findViewById<RecyclerView>(R.id.recycler)
        val empty = findViewById<TextView>(R.id.tvEmpty)
        val tvMe = findViewById<TextView>(R.id.tvMe)
        rv.layoutManager = GridLayoutManager(this, resources.getInteger(R.integer.redeem_cols))
        quickAnim(rv)

        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.redeem() }.getOrNull() }
            val items = r?.items.orEmpty()
            tvMe.text = "当前积分 " + (r?.me?.points.orEmpty()) +
                " · " + (r?.me?.vip?.name ?: "普通用户")
            if (r?.enabled == false || items.isEmpty()) {
                empty.text = if (r?.enabled == false) "站点没开兑换功能" else "还没有可兑换的项目"
                empty.visibility = View.VISIBLE
                return@launch
            }
            rv.adapter = RedeemAdapter(items) { doRedeem(it) }
        }
    }

    private fun doRedeem(it: Api.RedeemItem) {
        val tvMe = findViewById<TextView>(R.id.tvMe)
        tvMe.text = "兑换中…"
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                runCatching { Api.redeemPost(it.id.orEmpty()) }.getOrNull()
            }
            tvMe.text = if (r?.ok == true) "兑换成功：" + it.title.orEmpty()
            else "兑换失败：" + (r?.error ?: "积分不够或已兑完")
        }
    }
}
