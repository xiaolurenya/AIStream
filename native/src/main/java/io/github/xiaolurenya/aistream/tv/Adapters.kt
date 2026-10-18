package io.github.xiaolurenya.aistream.tv

import android.annotation.SuppressLint
import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.viewpager2.widget.ViewPager2
import coil.load

// ---------- 海报卡（首页横向栏目、搜索/收藏/历史网格共用） ----------
class PosterAdapter(
    private val items: MutableList<Api.Card> = mutableListOf(),
    private val onClick: (Api.Card) -> Unit,
    private val onLongClick: ((Api.Card) -> Unit)? = null
) : RecyclerView.Adapter<PosterAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val img: ImageView = v.findViewById(R.id.img)
        val title: TextView = v.findViewById(R.id.tvTitle)
        val sub: TextView = v.findViewById(R.id.tvSub)
        val badge: TextView = v.findViewById(R.id.tvBadge)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_poster, parent, false))

    override fun getItemCount() = items.size

    @SuppressLint("SetTextI18n")
    override fun onBindViewHolder(h: H, i: Int) {
        val it = items[i]
        // 点击回调要拿到的是这一项的数据，不是被点的 View
        val card = it
        h.title.text = it.title.orEmpty()
        val y = it.year.orEmpty()
        val sc = it.score.orEmpty().toDoubleOrNull()
        h.sub.text = if (sc != null && sc > 0) "%.1f".format(sc) else ""
        h.badge.text = y
        h.badge.visibility = if (y.isBlank()) View.GONE else View.VISIBLE
        val u = Api.dimg(it.poster)
        if (u.isBlank()) {
            h.img.setImageDrawable(null)
            h.img.setBackgroundColor(0xFF1B2233.toInt())
        } else {
            h.img.setBackgroundColor(0x00000000)
            h.img.load(u)
        }
        h.itemView.setOnClickListener { onClick(card) }
        if (onLongClick != null) {
            h.itemView.setOnLongClickListener { onLongClick.invoke(card); true }
        }
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
        val sub = PosterAdapter(col.items.orEmpty().toMutableList(), onClick)
        h.rv.adapter = sub
        if (h.rv.layoutManager == null) {
            h.rv.layoutManager = LinearLayoutManager(h.rv.context, LinearLayoutManager.HORIZONTAL, false)
        }
    }

    fun submit(list: List<Api.Column>) {
        cols.clear()
        cols.addAll(list)
        notifyDataSetChanged()
    }
}

// ---------- 首页顶部海报轮播 ----------
// 数据源就是首页栏目本身，不用后台多配一项：挑「推荐/最新/热门」栏目的前几条、
// 有海报的优先、按片名去重。这样任何一套站点装好就有轮播。
class BannerAdapter(
    private val onClick: (Api.Card) -> Unit
) : RecyclerView.Adapter<BannerAdapter.H>() {

    private val items = mutableListOf<Api.Card>()
    private var holder: H? = null

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val pager: ViewPager2 = v.findViewById(R.id.pager)
        val dots: LinearLayout = v.findViewById(R.id.dots)
        var cb: ViewPager2.OnPageChangeCallback? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_banner, parent, false))

    // 整块轮播只是一个 item；没数据就完全不占位
    override fun getItemCount() = if (items.isEmpty()) 0 else 1

    override fun onBindViewHolder(h: H, i: Int) {
        h.pager.adapter = PageAdapter(items, onClick)
        h.cb?.let { h.pager.unregisterOnPageChangeCallback(it) }
        val cb = object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(p: Int) = paintDots(h.dots, items.size, p)
        }
        h.cb = cb
        h.pager.registerOnPageChangeCallback(cb)
        paintDots(h.dots, items.size, h.pager.currentItem)
        holder = h
    }

    override fun onViewRecycled(h: H) {
        h.cb?.let { h.pager.unregisterOnPageChangeCallback(it) }
        h.cb = null
        if (holder === h) holder = null
        super.onViewRecycled(h)
    }

    // 由 Fragment 的定时回调驱动翻页；轮播被滚出屏幕时安静跳过
    fun next(): Boolean {
        val h = holder ?: return false
        val n = items.size
        if (n <= 1) return false
        h.pager.setCurrentItem((h.pager.currentItem + 1) % n, true)
        return true
    }

    fun submit(list: List<Api.Card>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    private fun Int.dp(ctx: Context): Int =
        (this * ctx.resources.displayMetrics.density).toInt()

    private fun paintDots(box: LinearLayout, n: Int, cur: Int) {
        box.removeAllViews()
        if (n <= 1) return
        val ctx = box.context
        for (k in 0 until n) {
            val d = View(ctx)
            val w = if (k == cur) 16 else 6
            val lp = LinearLayout.LayoutParams(w.dp(ctx), 6.dp(ctx))
            lp.marginEnd = 5.dp(ctx)
            d.layoutParams = lp
            d.setBackgroundResource(if (k == cur) R.drawable.dot_on else R.drawable.dot_off)
            box.addView(d)
        }
    }

    private class PageAdapter(
        private val items: List<Api.Card>,
        private val onClick: (Api.Card) -> Unit
    ) : RecyclerView.Adapter<PageAdapter.P>() {

        class P(v: View) : RecyclerView.ViewHolder(v) {
            val bg: ImageView = v.findViewById(R.id.bg)
            val poster: ImageView = v.findViewById(R.id.poster)
            val title: TextView = v.findViewById(R.id.tvTitle)
            val meta: TextView = v.findViewById(R.id.tvMeta)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): P =
            P(LayoutInflater.from(parent.context).inflate(R.layout.item_banner_page, parent, false))

        override fun getItemCount() = items.size

        override fun onBindViewHolder(h: P, i: Int) {
            val c = items[i]
            h.title.text = c.title.orEmpty()
            val bits = mutableListOf<String>()
            if (!c.year.isNullOrBlank()) bits.add(c.year!!)
            if (!c.station.isNullOrBlank()) bits.add(c.station!!)
            val sc = c.score.orEmpty().toDoubleOrNull()
            if (sc != null && sc > 0) bits.add("%.1f".format(sc))
            h.meta.text = bits.joinToString(" · ")

            val bgUrl = Api.dimg(c.poster)
            if (bgUrl.isNotBlank()) {
                // 海报是竖图，铺满会被裁掉大半；这里压到 0.55 透明度当背景板，
                // 再叠一层底部渐变，前景的海报和标题才立得住
                h.bg.load(bgUrl)
                h.poster.load(bgUrl)
            } else {
                h.bg.setImageDrawable(null)
                h.poster.setImageDrawable(null)
            }
            h.itemView.setOnClickListener { onClick(c) }
        }
    }
}

// ---------- 线路 / 分集（chip 样式） ----------
class ChipAdapter(
    private val items: List<String>,
    private val picked: () -> Int,
    private val onClick: (Int) -> Unit
) : RecyclerView.Adapter<ChipAdapter.H>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val tv: TextView = v.findViewById(R.id.tv)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_ep, parent, false))

    override fun getItemCount() = items.size

    override fun onBindViewHolder(h: H, i: Int) {
        h.tv.text = items[i]
        val on = i == picked()
        h.tv.setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
        h.tv.setTextColor(h.tv.context.getColor(if (on) R.color.accent_soft else R.color.fg_dim))
        h.tv.setOnClickListener { onClick(i) }
    }

    fun refresh() = notifyDataSetChanged()
}
