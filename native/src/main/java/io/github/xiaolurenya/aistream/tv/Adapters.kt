package io.github.xiaolurenya.aistream.tv

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Paint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import coil.size.Size
import coil.transform.Transformation

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

// ---------- 首页顶部海报轮播：ViewPager2 的页面 ----------
// 数据源就是首页栏目本身，不用后台多配一项：HomeFragment 先挑好「推荐/最新/热门」的
// 前几条、按片名去重、只留有海报的，再喂进来。
class BannerPageAdapter(
    private val onClick: (Api.Card) -> Unit
) : RecyclerView.Adapter<BannerPageAdapter.P>() {

    private val items = mutableListOf<Api.Card>()

    class P(v: View) : RecyclerView.ViewHolder(v) {
        val bg: ImageView = v.findViewById(R.id.bg)
        val poster: ImageView = v.findViewById(R.id.poster)
        val title: TextView = v.findViewById(R.id.tvTitle)
        val meta: TextView = v.findViewById(R.id.tvMeta)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): P =
        P(LayoutInflater.from(parent.context).inflate(R.layout.item_banner_page, parent, false))

    override fun getItemCount() = items.size

    @SuppressLint("SetTextI18n")
    override fun onBindViewHolder(h: P, i: Int) {
        val c = items[i]
        h.title.text = c.title.orEmpty()

        val bits = mutableListOf<String>()
        if (!c.year.isNullOrBlank()) bits.add(c.year!!)
        if (!c.station.isNullOrBlank()) bits.add(c.station!!)
        val sc = c.score.orEmpty().toDoubleOrNull()
        if (sc != null && sc > 0) bits.add("%.1f".format(sc))
        h.meta.text = bits.joinToString(" · ")

        val u = Api.dimg(c.poster)
        if (u.isBlank()) {
            h.bg.setImageDrawable(null)
            h.poster.setImageDrawable(null)
        } else {
            // 背景那张做轻度模糊：海报是竖图，铺在横幅里必然裁上下，
            // 不模糊就会出现「人物缺半张脸」的观感；抹平后只剩色块，前景海报才立得住。
            // 透明度压到 0.5 + 底部渐变叠上去，标题照样看得清。
            h.bg.load(u) { transformations(SoftBlur()) }
            h.poster.load(u)
        }
        h.itemView.setOnClickListener { onClick(c) }
    }

    fun submit(list: List<Api.Card>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }
}

// 轻度高斯近似：先降采样再 BlurMaskFilter，不碰 RenderScript（API 31 起废弃），低版本也能跑
private class SoftBlur : Transformation {
    override val cacheKey = "softblur-v1"
    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        val k = 0.12f
        val w = (input.width * k).toInt().coerceAtLeast(1)
        val h = (input.height * k).toInt().coerceAtLeast(1)
        val small = Bitmap.createScaledBitmap(input, w, h, true)
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        p.maskFilter = BlurMaskFilter(6f, BlurMaskFilter.Blur.NORMAL)
        c.drawBitmap(small, 0f, 0f, p)
        return out
    }
    override fun equals(other: Any?) = other is SoftBlur
    override fun hashCode() = cacheKey.hashCode()
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
