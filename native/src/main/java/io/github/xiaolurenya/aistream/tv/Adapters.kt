package io.github.xiaolurenya.aistream.tv

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
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
    private val onClick: (Api.Card) -> Unit,
    /* 所有栏目行共用一个回收池：滑到第三栏时第一栏那批 ViewHolder 能直接拿来用，
       不用重新 inflate —— 首页栏目多的时候这一步最省时间。 */
    private val pool: RecyclerView.RecycledViewPool? = null
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
        if (h.rv.layoutManager == null) {
            // 横向行首屏多预取几张，滑过去不会先白一下再出图
            h.rv.layoutManager = LinearLayoutManager(h.rv.context, LinearLayoutManager.HORIZONTAL, false)
                .apply { initialPrefetchItemCount = 4 }
        }
        if (pool != null) h.rv.setRecycledViewPool(pool)
        h.rv.setItemViewCacheSize(8)
        h.rv.adapter = PosterAdapter(col.items.orEmpty().toMutableList(), onClick)
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

/* 背景柔焦。⚠️ 上一版是「降采样到 12% + BlurMaskFilter」——BlurMaskFilter 只糊 alpha 边缘、
   不糊画面内容，实际全靠那 12% 的像素被硬拉到全屏，于是就成了大哥说的「糊成一团马赛克」。
   现在改成：降采样到 50% → 跑三趟滑动窗口盒式模糊（三趟盒式已经很接近高斯）→
   交给 ImageView 双线性放大。糊出来是「柔焦」不是「马赛克」，人物轮廓还在。 */
private class SoftBlur(
    private val scale: Float = 0.5f,
    private val radius: Int = 4
) : Transformation {

    override val cacheKey = "softblur-v2"

    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        val w = (input.width * scale).toInt().coerceAtLeast(1)
        val h = (input.height * scale).toInt().coerceAtLeast(1)
        val small = Bitmap.createScaledBitmap(input, w, h, true)
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        val buf = IntArray(w * h)
        // 三趟盒式 ≈ 一次高斯，比真高斯快一个数量级，纯 Kotlin 不依赖 RenderScript
        repeat(3) { boxBlur(px, buf, w, h, radius) }
        val out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        out.setPixels(px, 0, w, 0, 0, w, h)
        if (small !== input) small.recycle()
        return out
    }

    // 滑动窗口盒式模糊：横一趟 + 竖一趟，窗口里只做加减不做重扫，O(宽×高)
    private fun boxBlur(px: IntArray, buf: IntArray, w: Int, h: Int, r: Int) {
        val win = r + r + 1
        for (y in 0 until h) {
            val base = y * w
            var sr = 0; var sg = 0; var sb = 0
            for (k in -r..r) {
                val p = px[base + k.coerceIn(0, w - 1)]
                sr += (p ushr 16) and 0xFF
                sg += (p ushr 8) and 0xFF
                sb += p and 0xFF
            }
            for (x in 0 until w) {
                buf[base + x] = OPAQUE or ((sr / win) shl 16) or ((sg / win) shl 8) or (sb / win)
                val oi = (x - r).coerceIn(0, w - 1)
                val ii = (x + r + 1).coerceIn(0, w - 1)
                if (oi != ii) {
                    val po = px[base + oi]
                    val pi = px[base + ii]
                    sr += ((pi ushr 16) and 0xFF) - ((po ushr 16) and 0xFF)
                    sg += ((pi ushr 8) and 0xFF) - ((po ushr 8) and 0xFF)
                    sb += (pi and 0xFF) - (po and 0xFF)
                }
            }
        }
        for (x in 0 until w) {
            var sr = 0; var sg = 0; var sb = 0
            for (k in -r..r) {
                val p = buf[k.coerceIn(0, h - 1) * w + x]
                sr += (p ushr 16) and 0xFF
                sg += (p ushr 8) and 0xFF
                sb += p and 0xFF
            }
            for (y in 0 until h) {
                px[y * w + x] = OPAQUE or ((sr / win) shl 16) or ((sg / win) shl 8) or (sb / win)
                val oi = (y - r).coerceIn(0, h - 1)
                val ii = (y + r + 1).coerceIn(0, h - 1)
                if (oi != ii) {
                    val po = buf[oi * w + x]
                    val pi = buf[ii * w + x]
                    sr += ((pi ushr 16) and 0xFF) - ((po ushr 16) and 0xFF)
                    sg += ((pi ushr 8) and 0xFF) - ((po ushr 8) and 0xFF)
                    sb += (pi and 0xFF) - (po and 0xFF)
                }
            }
        }
    }

    private companion object { val OPAQUE = 0xFF000000.toInt() }

    override fun equals(other: Any?) = other is SoftBlur
    override fun hashCode() = cacheKey.hashCode()
}

// ---------- 列表手感 ----------
/* 默认 ItemAnimator 是 250ms，快速滑动和整表刷新时会明显拖沓。
   统一压到 120ms：既跟手又不生硬。 */
fun quickAnim(rv: RecyclerView) {
    rv.itemAnimator = DefaultItemAnimator().apply {
        addDuration = 120L
        removeDuration = 120L
        moveDuration = 120L
        changeDuration = 90L
    }
}

/* 线路/选集/解析器这类「点一下换个高亮」的 chip 列表要的是立刻生效，
   任何补间动画都只会让人觉得卡一下 —— 直接关掉。 */
fun noAnim(rv: RecyclerView) {
    rv.itemAnimator = null
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
