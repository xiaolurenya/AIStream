package io.github.xiaolurenya.aistream.tv

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 积分兑换：会员时长 / 临时权限，花站点积分换
class RedeemActivity : AppCompatActivity() {

    private val items = mutableListOf<Api.RedeemItem>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_redeem)

        val swipe = findViewById<SwipeRefreshLayout>(R.id.swipe)
        val rv = findViewById<RecyclerView>(R.id.recycler)
        val empty = findViewById<TextView>(R.id.tvEmpty)
        rv.layoutManager = LinearLayoutManager(this)
        rv.adapter = Adapter()
        swipe.setOnRefreshListener { load() }
        load()
    }

    private fun load() {
        val swipe = findViewById<SwipeRefreshLayout>(R.id.swipe)
        val empty = findViewById<TextView>(R.id.tvEmpty)
        swipe.isRefreshing = true
        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.redeem() }.getOrNull() }
            swipe.isRefreshing = false
            items.clear()
            items.addAll(r?.items.orEmpty())
            findViewById<RecyclerView>(R.id.recycler).adapter?.notifyDataSetChanged()
            empty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
            title = "积分兑换（我的积分 " + (r?.me?.points ?: "0") + "）"
        }
    }

    private fun doRedeem(it: Api.RedeemItem) {
        AlertDialog.Builder(this)
            .setTitle("确认兑换")
            .setMessage((it.title ?: "") + "\n花费 " + (it.cost ?: "0") + " 积分")
            .setNegativeButton("再想想", null)
            .setPositiveButton("兑换") { _, _ ->
                lifecycleScope.launch {
                    val r = withContext(Dispatchers.IO) {
                        runCatching { Api.redeemPost(it.id.orEmpty()) }.getOrNull()
                    }
                    Toast.makeText(
                        this@RedeemActivity,
                        if (r?.ok == true) "兑换成功" else ("兑换失败：" + (r?.error ?: "站点没响应")),
                        Toast.LENGTH_SHORT
                    ).show()
                    load()
                }
            }
            .show()
    }

    private inner class Adapter : RecyclerView.Adapter<Adapter.H>() {

        inner class H(v: View) : RecyclerView.ViewHolder(v) {
            val t: TextView = v.findViewById(R.id.tvTitle)
            val d: TextView = v.findViewById(R.id.tvDesc)
            val b: TextView = v.findViewById(R.id.btnGo)
        }

        override fun onCreateViewHolder(p: ViewGroup, viewType: Int): H =
            H(LayoutInflater.from(p.context).inflate(R.layout.item_redeem, p, false))

        override fun getItemCount() = items.size

        override fun onBindViewHolder(h: H, i: Int) {
            val it = items[i]
            h.t.text = it.title.orEmpty()
            val kind = if (it.kind == "perm") "权限" else "会员"
            h.d.text = listOf(
                it.desc,
                kind + (if (it.kind == "perm") "" else " Lv" + (it.level ?: "0")),
                (it.days ?: "0") + " 天"
            ).filter { it.isNotBlank() }.joinToString(" · ")
            h.b.text = (it.cost ?: "0") + " 分"
            h.b.isEnabled = !it.soldOut
            h.b.alpha = if (it.soldOut) 0.5f else 1f
            h.b.text = if (it.soldOut) "已兑完" else (it.cost ?: "0") + " 分"
            h.b.setOnClickListener { if (!it.soldOut) doRedeem(it) }
        }
    }
}
