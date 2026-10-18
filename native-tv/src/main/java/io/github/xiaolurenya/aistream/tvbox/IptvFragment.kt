package io.github.xiaolurenya.aistream.tvbox

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// 直播：先列频道，选中就进播放页（播放页里左右键还能接着换台）
class IptvFragment : Fragment(R.layout.fragment_iptv) {

    override fun onViewCreated(v: View, savedInstanceState: Bundle?) {
        val rv = v.findViewById<RecyclerView>(R.id.recycler)
        val hint = v.findViewById<TextView>(R.id.tvHint)
        rv.layoutManager = LinearLayoutManager(requireContext())
        quickAnim(rv)

        lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) { runCatching { Api.iptv() }.getOrNull() }
            val list = r?.channels.orEmpty()
            PlayCache.iptvEpg = r?.now.orEmpty()
            hint.text = when {
                r == null -> "取频道列表失败，检查站点连通性"
                r.denied -> "管理员没给你的账号开直播权限"
                list.isEmpty() -> "后台还没配直播源"
                else -> "共 ${list.size} 个频道 · 上下键选台，确认键播放"
            }
            if (list.isEmpty()) return@launch

            rv.adapter = ChannelAdapter(list, PlayCache.iptvEpg) { i ->
                PlayCache.iptv = list
                PlayCache.iptvIndex = i
                startActivity(Intent(requireContext(), LiveActivity::class.java))
            }
        }
    }
}
