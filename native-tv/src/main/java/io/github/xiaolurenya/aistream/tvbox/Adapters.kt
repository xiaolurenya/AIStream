package io.github.xiaolurenya.aistream.tvbox

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load

/* 遥控器焦点反馈。TV 上没有鼠标悬停也没有触摸按下，「现在选中哪一项」全靠这一下
   放大 + 描边。130ms 够快，连按方向键不会拖影。 */
fun bindFocus(v: View, onFocus: ((Boolean) -> Unit)? = null) {
    v.setOnFocusChangeListener { _, has ->
        v.animate()
            .scaleX(if (has) 1.06f else 1f)
            .scaleY(if (has) 1.06f else 1f)
            .setDuration(130)
            .start()
        v.elevation = if (has) 14f else 0f
        onFocus?.invoke(has)
    }
}

// 列表动画压到 120ms：默认 250ms 在遥控器连按时明显拖沓
fun quickAnim(rv: RecyclerView) {
    rv.itemAnimator = DefaultItemAnimator().apply {
        addDuration = 120L
        removeDuration = 120L
        moveDuration = 120L
        changeDuration = 90L
    }
}

// 「点一下换个高亮」的 chip 列表要的是立刻生效，任何补间动画都只会让人觉得卡
fun noAnim(rv: RecyclerView) {
    rv.itemAnimator = null
}

// ---------- 海报卡（栏目行 / 网格页共用） ----------
class PosterAdapter(
    private val items: MutableList<Api.Card> = mutableListOf(),
    private val onClick: (Api.Card) -> Unit
) : RecyclerView.Adapter<PosterAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val card: View = v.findViewById(R.id.card)
        val img: ImageView = v.findViewById(R.id.img)
        val title: TextView = v.findViewById(R.id.tvTitle)
        val sub: TextView = v.findViewById(R.id.tvSub)
        val badge: TextView = v.findViewById(R.id.tvBadge)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_poster, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        // 点击回调要拿的是这一项的数据，不是被点的 View
        val card = items[i]
        h.title.text = card.title.orEmpty()
        val sc = card.score.orEmpty().toDoubleOrNull()
        h.sub.text = if (sc != null && sc > 0) "%.1f".format(sc) else ""
        val y = card.year.orEmpty()
        h.badge.text = y
        h.badge.visibility = if (y.isBlank()) View.GONE else View.VISIBLE

        val u = Api.dimg(card.poster)
        if (u.isBlank()) h.img.setImageDrawable(null) else h.img.load(u)

        bindFocus(h.card) { has ->
            h.card.setBackgroundResource(if (has) R.drawable.bg_focus else 0)
        }
        h.itemView.setOnClickListener { onClick(card) }
    }

    fun submit(list: List<Api.Card>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }
}

// ---------- 首页：一个栏目一行（标题 + 横向海报列表） ----------
class ColumnAdapter(
    private val onClick: (Api.Card) -> Unit
) : RecyclerView.Adapter<ColumnAdapter.H>() {

    private val cols = mutableListOf<Api.Column>()
    // 所有栏目行共用一个回收池：滑到第三行时能直接拿第一行的 ViewHolder 来用
    private val pool = RecyclerView.RecycledViewPool()

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val label: TextView = v.findViewById(R.id.tvLabel)
        val rv: RecyclerView = v.findViewById(R.id.rvItems)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_column, parent, false))

    override fun getItemCount() = cols.size

    override fun onBindViewHolder(h: H, i: Int) {
        val col = cols[i]
        h.label.text = col.label.orEmpty()
        if (h.rv.layoutManager == null) {
            h.rv.layoutManager = LinearLayoutManager(h.rv.context, LinearLayoutManager.HORIZONTAL, false)
                .apply { initialPrefetchItemCount = 6 }
        }
        h.rv.setRecycledViewPool(pool)
        h.rv.setItemViewCacheSize(10)
        h.rv.adapter = PosterAdapter(col.items.orEmpty().toMutableList(), onClick)
    }

    fun submit(list: List<Api.Column>) {
        cols.clear()
        cols.addAll(list)
        notifyDataSetChanged()
    }
}

// ---------- 线路 / 选集（chip 样式） ----------
/* wrap 必须放在 onClick 前面：Kotlin 的尾随 lambda 绑定最后一个参数，
   放在后面时 ChipAdapter(x, { picked }) { onClick } 会被当成传给 Boolean 报错。 */
class ChipAdapter(
    private val items: List<String>,
    private val picked: () -> Int,
    // 横向线路/解析器列表里 chip 别占满整行（全宽 chip 很难看），选集网格保持等分
    private val wrap: Boolean = false,
    private val onClick: (Int) -> Unit
) : RecyclerView.Adapter<ChipAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val tv: TextView = v.findViewById(R.id.tv)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_ep, parent, false)
        if (wrap) (v.layoutParams as? ViewGroup.MarginLayoutParams)?.width =
            ViewGroup.LayoutParams.WRAP_CONTENT
        return H(v)
    }

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        h.tv.text = items[i]
        val on = i == picked()
        // 选中态用实心高亮，焦点态用描边，两者分开画，别让「选中」被焦点盖掉
        h.tv.setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
        h.tv.setTextColor(h.tv.context.getColor(if (on) R.color.accent_soft else R.color.fg_dim))
        bindFocus(h.tv) { has ->
            if (has && i != picked()) h.tv.setBackgroundResource(R.drawable.bg_focus)
            else if (!has) h.tv.setBackgroundResource(if (i == picked()) R.drawable.bg_chip_on else R.drawable.bg_chip)
        }
        h.tv.setOnClickListener { onClick(i) }
    }

    fun refresh() = notifyDataSetChanged()
}

// ---------- 直播频道列表（图4 样式：编号 + 台标 + 正在播节目 + 播放进度条） ----------
class ChannelAdapter(
    private val items: List<Api.IptvCh>,
    private val epg: Map<String, Api.EpgNow> = emptyMap(),
    private val onPick: (Int) -> Unit
) : RecyclerView.Adapter<ChannelAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val row: View = v.findViewById(R.id.row)
        val num: TextView = v.findViewById(R.id.tvNum)
        val logo: ImageView = v.findViewById(R.id.imgLogo)
        val name: TextView = v.findViewById(R.id.tvName)
        val group: TextView = v.findViewById(R.id.tvGroup)
        val epg: TextView = v.findViewById(R.id.tvEpg)
        val pb: ProgressBar = v.findViewById(R.id.pbEpg)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        val c = items[i]
        // 图4 的三位编号
        h.num.text = "%03d".format(i + 1)
        h.name.text = c.name.orEmpty()
        h.group.text = c.group.orEmpty()

        // 台标：服务端给的是相对路径（自带 token），跟手机版一样拼域名
        val lu = c.logo.orEmpty()
        if (lu.isBlank()) h.logo.setImageDrawable(null)
        else h.logo.load(if (lu.startsWith("http")) lu else Prefs.base + lu)

        // 节目单：正在播 + 几点结束（后台没配 EPG 就不显示这两行）
        val e = epg[c.cid]
        if (e == null || e.t.isNullOrBlank()) {
            h.epg.visibility = View.GONE
            h.pb.visibility = View.GONE
        } else {
            h.epg.visibility = View.VISIBLE
            h.epg.text = "▶ " + e.t + (if (e.ce > 0) "（至 " + hhmm(e.ce) + "）" else "")
            // 播放进度：按本档节目的开始/结束时间戳算，不在区间内就不画
            val now = System.currentTimeMillis()
            if (e.cs > 0 && e.ce > e.cs && now >= e.cs && now <= e.ce) {
                h.pb.visibility = View.VISIBLE
                h.pb.progress = (((now - e.cs) * 1000L) / (e.ce - e.cs)).toInt().coerceIn(0, 1000)
            } else {
                h.pb.visibility = View.GONE
            }
        }

        bindFocus(h.row) { has ->
            h.row.setBackgroundResource(if (has) R.drawable.bg_focus else R.drawable.bg_card)
        }
        h.itemView.setOnClickListener { onPick(i) }
    }

    private fun hhmm(ts: Long): String =
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA).format(java.util.Date(ts))
}

// ---------- 会员兑换列表 ----------
class RedeemAdapter(
    private val items: List<Api.RedeemItem>,
    private val onPick: (Api.RedeemItem) -> Unit
) : RecyclerView.Adapter<RedeemAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val card: View = v.findViewById(R.id.card)
        val title: TextView = v.findViewById(R.id.tvTitle)
        val desc: TextView = v.findViewById(R.id.tvDesc)
        val cost: TextView = v.findViewById(R.id.tvCost)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_redeem, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        val d = items[i]
        h.title.text = d.title.orEmpty()
        h.desc.text = d.desc.orEmpty()
        h.cost.text = if (d.soldOut) "已兑完" else (d.cost.orEmpty() + " 积分")
        bindFocus(h.card) { has ->
            h.card.setBackgroundResource(if (has) R.drawable.bg_focus else R.drawable.bg_card)
        }
        h.itemView.setOnClickListener { onPick(d) }
    }
}
