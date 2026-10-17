package io.github.xiaolurenya.aistream.tv

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import coil.load
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 直播：分组 + 频道网格。能不能看由后台 IPTV 开关和账号权限决定，服务端已经过滤过了
class IptvFragment : Fragment(R.layout.fragment_iptv) {

    private var all: List<Api.IptvCh> = emptyList()
    private var groups: List<String> = listOf("全部")
    private var groupIdx = 0

    private lateinit var rvGroups: RecyclerView
    private lateinit var recycler: RecyclerView
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var empty: TextView

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        rvGroups = v.findViewById(R.id.rvGroups)
        recycler = v.findViewById(R.id.recycler)
        swipe = v.findViewById(R.id.swipe)
        empty = v.findViewById(R.id.tvEmpty)

        rvGroups.layoutManager = LinearLayoutManager(requireContext(), LinearLayoutManager.HORIZONTAL, false)
        recycler.layoutManager = GridLayoutManager(requireContext(), 2)
        swipe.setOnRefreshListener { load() }
        load()
    }

    private fun load() {
        swipe.isRefreshing = true
        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.iptv() }.getOrNull() }
            swipe.isRefreshing = false

            all = r?.channels.orEmpty()
            empty.visibility = if (all.isEmpty()) View.VISIBLE else View.GONE
            if (r?.denied == true) empty.setText(R.string.iptv_empty)
            if (!r?.error.isNullOrBlank()) empty.text = "清单拉取失败：" + r!!.error

            // 分组顺序以后台配置为准，没配的按出现顺序补在后面
            val gs = LinkedHashSet<String>()
            for (g in r?.groupOrder.orEmpty()) if (all.any { it.group == g }) gs.add(g)
            for (c in all) if (!c.group.isNullOrBlank()) gs.add(c.group!!)
            groups = listOf("全部") + gs
            groupIdx = 0
            paintGroups()
            paintChannels()
        }
    }

    private fun paintGroups() {
        rvGroups.adapter = ChipAdapter(groups, { groupIdx }) { i ->
            groupIdx = i
            rvGroups.adapter?.notifyDataSetChanged()
            paintChannels()
        }
    }

    private fun paintChannels() {
        val g = groups.getOrNull(groupIdx) ?: "全部"
        val list = if (groupIdx == 0) all else all.filter { it.group == g }
        PlayCache.iptv = list
        recycler.adapter = ChannelAdapter(list) { idx ->
            PlayCache.iptvIndex = idx
            startActivity(android.content.Intent(requireContext(), LiveActivity::class.java))
        }
    }
}

class ChannelAdapter(
    private val items: List<Api.IptvCh>,
    private val onClick: (Int) -> Unit
) : RecyclerView.Adapter<ChannelAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val name: TextView = v.findViewById(R.id.tvName)
        val logo: ImageView = v.findViewById(R.id.imgLogo)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        val c = items[i]
        h.name.text = c.name.orEmpty()
        // 服务端返回的台标路径已经带上了自己的 token，直接拼域名就行
        val lg = c.logo.orEmpty()
        if (lg.isNotBlank()) {
            h.logo.visibility = View.VISIBLE
            h.logo.load(Prefs.base + lg)
        } else {
            h.logo.visibility = View.GONE
        }
        h.itemView.setOnClickListener { onClick(i) }
    }
}
