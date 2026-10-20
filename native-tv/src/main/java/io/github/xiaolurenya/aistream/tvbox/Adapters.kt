package io.github.xiaolurenya.aistream.tvbox

import android.graphics.Rect
import android.media.AudioManager
import android.media.ToneGenerator
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
   放大 + 描边。150ms 够快，连按方向键不会拖影。
   v1.4.0 大哥要求「选择任何栏目带声音」→ 聚焦时来一声很轻的提示音（系统按键音在
   TV 上常被关掉，所以自己用 ToneGenerator 出声，音量压得很低不吵）。 */
private var focusTone: ToneGenerator? = null

fun focusBeep() {
    try {
        if (focusTone == null) focusTone = ToneGenerator(AudioManager.STREAM_MUSIC, 40)
        focusTone?.startTone(ToneGenerator.TONE_PROP_BEEP, 70)
    } catch (e: Exception) {
        // 个别盒子 ToneGenerator 初始化失败：没声音就不响，别崩
    }
}

/* 遥控器焦点反馈（参考奈飞）：放大 + 一圈白色描边浮层 + 轻提示音。
   v1.4.2 关键改动：焦点标识从「换背景」改成 View.foreground 画描边——
   换背景有三个毛病：① 海报卡的背景被海报图整个盖住，选中了也看不出（大哥图2）；
   ② 彩色导航卡换底后圆角丢失，看着像方块（大哥图5）；③ 按钮换底后描边生硬（大哥图3）。
   描边浮在内容上面谁都看得见，原来的形状/选中色全部保留。
   v1.4.15：① 去掉 elevation 阴影——深色底上阴影发脏发糊，还拖累盒子 GPU
   （大哥图4 点名「选中后底层有阴影」）；② 120ms + 减速插值器，遥控器挪动更跟手。 */
fun bindFocus(v: View, onFocus: ((Boolean) -> Unit)? = null) {
    v.setOnFocusChangeListener { _, has ->
        if (has) focusBeep()
        v.elevation = 0f
        v.animate()
            .scaleX(if (has) 1.06f else 1f)
            .scaleY(if (has) 1.06f else 1f)
            .setDuration(120L)
            .setInterpolator(android.view.animation.DecelerateInterpolator(1.6f))
            .start()
        v.foreground = if (has)
            androidx.core.content.ContextCompat.getDrawable(v.context, R.drawable.bg_focus_ring)
        else null
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

/* 海报网格列数：按「poster_w + 间距」现算，不再用固定的 grid_cols。
   固定列数在大屏上每格空一大截（栏目网格间隔大得离谱的根因）；
   动态算出来的列数让每格只比卡片宽 0~2 个间距，排出来是紧凑的一面海报墙。 */
fun posterSpanCount(ctx: android.content.Context): Int {
    val dm = ctx.resources.displayMetrics
    val pad = ctx.resources.getDimensionPixelSize(R.dimen.page_pad) * 2
    val item = ctx.resources.getDimensionPixelSize(R.dimen.poster_w) + (12 * dm.density).toInt()
    return (((dm.widthPixels - pad).toFloat() / item).coerceIn(3f, 9f).toInt())
}

// ---------- 海报卡（栏目行 / 网格页共用） ----------
/* onMore 传了就在列表末尾挂一张「显示更多」卡（分类页翻页用），拉空自动收起来；
   不传跟原来完全一样（首页栏目行 / 搜索 / 收藏 / 历史）。 */
class PosterAdapter(
    private val items: MutableList<Api.Card> = mutableListOf(),
    private val onClick: (Api.Card) -> Unit,
    private val onMore: (() -> Unit)? = null
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val card: View = v.findViewById(R.id.card)
        val img: ImageView = v.findViewById(R.id.img)
        val title: TextView = v.findViewById(R.id.tvTitle)
        val sub: TextView = v.findViewById(R.id.tvSub)
        val badge: TextView = v.findViewById(R.id.tvBadge)

        init {
            // 海报圆角：按背景 bg_card 的圆角轮廓裁切（XML 里的 clipToOutline 只有 API31+ 认，这里兜底）
            img.clipToOutline = true
        }
    }

    class MoreH(v: View) : RecyclerView.ViewHolder(v) {
        val tv: TextView = v.findViewById(R.id.tvMore)
    }

    // 「显示更多」卡：传了 onMore 就先亮出来，拉到空页再收
    var hasMore: Boolean = onMore != null
        private set

    // 「显示更多」卡文案：拉下一页时切成「加载中…」，让大哥知道点了有反应
    private var moreLabel: String = "显示更多"

    fun setMoreLabel(s: String) {
        if (moreLabel == s) return
        moreLabel = s
        if (hasMore) notifyItemChanged(items.size)
    }

    fun setHasMore(on: Boolean) {
        if (hasMore == on) return
        val pos = items.size
        hasMore = on
        if (on) notifyItemInserted(pos) else notifyItemRemoved(pos)
    }

    override fun getItemCount() = items.size + if (hasMore) 1 else 0

    override fun getItemViewType(pos: Int): Int =
        if (hasMore && pos == items.size) 1 else 0

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
        if (viewType == 1) {
            MoreH(LayoutInflater.from(parent.context).inflate(R.layout.item_more, parent, false))
        } else {
            H(LayoutInflater.from(parent.context).inflate(R.layout.item_poster, parent, false))
        }

    override fun onBindViewHolder(h: RecyclerView.ViewHolder, i: Int) {
        if (h is MoreH) {
            bindFocus(h.tv)
            h.tv.text = moreLabel
            h.tv.setOnClickListener { onMore?.invoke() }
            return
        }
        h as H
        // 点击回调要拿的是这一项的数据，不是被点的 View
        val card = items[i]
        h.title.text = card.title.orEmpty()
        val sc = card.score.orEmpty().toDoubleOrNull()
        val sub = if (sc != null && sc > 0) "%.1f".format(sc) else ""
        h.sub.text = sub
        // 评分空就整行收起：空 TextView 也占一行高，网格里会白出一截空档
        h.sub.visibility = if (sub.isBlank()) View.GONE else View.VISIBLE
        val y = card.year.orEmpty()
        h.badge.text = y
        h.badge.visibility = if (y.isBlank()) View.GONE else View.VISIBLE

        val u = Api.dimg(card.poster)
        if (u.isBlank()) h.img.setImageDrawable(null) else h.img.load(u)

        // 焦点 = 白描边浮层（bindFocus 统一出），背景不再换——换了也被海报图盖住看不见
        bindFocus(h.card)
        h.itemView.setOnClickListener { onClick(card) }
    }

    fun submit(list: List<Api.Card>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    // 「显示更多」翻页：追加下一页，只刷新新增区间（整表 notify 会让焦点跳回第一行）
    fun append(list: List<Api.Card>) {
        val from = items.size
        items.addAll(list)
        notifyItemRangeInserted(from, list.size)
    }
}

/* 网格/行间距：海报卡不再自带内边距（那会让横竖间隙不一致，「间距不平均」的根因），
   全部交给这里统一出：网格 (h=12dp, v=16dp)，首页栏目行只出横向 (12dp, 0)。 */
class SpacesItemDecoration(private val h: Int, private val v: Int) : RecyclerView.ItemDecoration() {
    override fun getItemOffsets(out: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
        out.left = h / 2
        out.right = h / 2
        out.top = v / 2
        out.bottom = v / 2
    }
}

// ---------- 首页：一个栏目一行（标题 + 横向海报列表） ----------
/* loadMore：每行横向滑到末尾自动拉下一页（服务端按栏目配置序号翻页）。
   回调由 Fragment 用生命周期协程跑网络，结果回主线程交给 adapter.append，
   适配器本身不持有协程作用域。 */
class ColumnAdapter(
    private val onClick: (Api.Card) -> Unit,
    private val loadMore: (serverIdx: Int, page: Int, onResult: (List<Api.Card>) -> Unit) -> Unit,
    // 栏目标题被遥控器选中 / 点击：弹出该栏目的满屏海报墙（对应顶部分类标签的入口）
    private val onOpenCol: (serverIdx: Int) -> Unit = {}
) : RecyclerView.Adapter<ColumnAdapter.H>() {

    private val cols = mutableListOf<Api.Column>()
    // 所有栏目行共用一个回收池：滑到第三行时能直接拿第一行的 ViewHolder 来用
    private val pool = RecyclerView.RecycledViewPool()
    // 每行翻页状态（下标与 cols 对齐）：page=已拉到的页；loading=拉取中；done=没更多了
    private val st = mutableListOf<RowState>()

    private data class RowState(var page: Int = 1, var loading: Boolean = false, var done: Boolean = false)

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val label: TextView = v.findViewById(R.id.tvLabel)
        val rv: RecyclerView = v.findViewById(R.id.rvItems)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H {
        val h = H(LayoutInflater.from(parent.context).inflate(R.layout.item_column, parent, false))
        // 横向「显示更多」：滑到最后几张就拉下一页（每行独立翻页，互不干扰）
        h.rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                val pos = h.bindingAdapterPosition
                if (pos < 0 || pos >= st.size) return
                val row = st[pos]
                val ad = rv.adapter as? PosterAdapter ?: return
                val lm = rv.layoutManager as? LinearLayoutManager ?: return
                if (!row.loading && !row.done && lm.findLastVisibleItemPosition() >= ad.itemCount - 6) {
                    row.loading = true
                    loadMore(cols[pos].idx, row.page + 1) { more ->
                        if (more.isEmpty()) row.done = true
                        else { row.page++; ad.append(more) }
                        row.loading = false
                    }
                }
            }
        })
        return h
    }

    override fun getItemCount() = cols.size

    override fun onBindViewHolder(h: H, i: Int) {
        val col = cols[i]
        h.label.text = col.label.orEmpty()
        // 栏目标题：可聚焦 + 白描边，确认键 / 点击弹满屏海报墙（按下返回自动归位）
        h.label.setOnClickListener { onOpenCol(col.idx) }
        bindFocus(h.label)
        if (h.rv.layoutManager == null) {
            h.rv.layoutManager = LinearLayoutManager(h.rv.context, LinearLayoutManager.HORIZONTAL, false)
                .apply { initialPrefetchItemCount = 6 }
            // 卡片间距统一走装饰（横 12dp），和网格页保持一致
            h.rv.addItemDecoration(SpacesItemDecoration((12 * h.rv.context.resources.displayMetrics.density).toInt(), 0))
        }
        h.rv.setRecycledViewPool(pool)
        h.rv.setItemViewCacheSize(10)
        h.rv.adapter = PosterAdapter(col.items.orEmpty().toMutableList(), onClick)
    }

    fun submit(list: List<Api.Column>) {
        cols.clear()
        cols.addAll(list)
        st.clear()
        list.forEach { st.add(RowState()) }
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
        // 选中 = 实心蓝底白字；未选中 = 亮字。焦点只出白描边（不再换底色，
        // 「选中」和「正在聚焦」是两件事：选中色保留，聚焦加一圈白边）
        h.tv.setBackgroundResource(if (on) R.drawable.bg_chip_on else R.drawable.bg_chip)
        h.tv.setTextColor(if (on) android.graphics.Color.WHITE else h.tv.context.getColor(R.color.fg))
        bindFocus(h.tv)
        h.tv.setOnClickListener { onClick(i) }
    }

    fun refresh() = notifyDataSetChanged()
}

// ---------- 直播频道列表（图4 样式：编号 + 台标 + 正在播节目 + 播放进度条） ----------
class ChannelAdapter(
    items: List<Api.IptvCh>,
    private val epg: Map<String, Api.EpgNow> = emptyMap(),
    curCid: String = "",
    private val onPick: (Int) -> Unit
) : RecyclerView.Adapter<ChannelAdapter.H>() {

    private val rows = items.toMutableList()
    var curCid: String = curCid
        private set

    /* 复用同一个 adapter 刷新列表：选台面板的搜索框每敲一个字就 new 一个 adapter
       全量重建（+ item 动画），遥控器/输入法敲字能明显感觉到卡 —— 现在只换数据。 */
    fun submit(list: List<Api.IptvCh>, nowCid: String) {
        val changed = list != rows || nowCid != curCid
        rows.clear()
        rows.addAll(list)
        curCid = nowCid
        if (changed) notifyDataSetChanged()
    }

    class H(v: View) : RecyclerView.ViewHolder(v) {
        val row: View = v.findViewById(R.id.row)
        val num: TextView = v.findViewById(R.id.tvNum)
        val logoBox: View = v.findViewById(R.id.flLogo)
        val logo: ImageView = v.findViewById(R.id.imgLogo)
        // v1.4.14：台名/节目名就是 MarqueeTextView（自绘裁剪跑马灯），直接 bind/stop
        val name: MarqueeTextView = v.findViewById(R.id.tvName)
        val epg: MarqueeTextView = v.findViewById(R.id.tvEpg)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): H =
        H(LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false))

    override fun getItemCount() = rows.size

    override fun onBindViewHolder(h: H, i: Int) {
        val c = rows[i]
        // 图4 的三位编号
        h.num.text = "%03d".format(i + 1)
        // v1.4.14：台名走 MarqueeTextView 自绘跑马灯（开头停一下读全名 → 滚到最后一字完整可见 → 停一下回开头）
        h.name.bindMarquee(c.name.orEmpty())

        // 台标：服务端给的是相对路径（自带 token），跟手机版一样拼域名。
        // v1.4.12：没台标的台、以及台标地址加载失败的台（果果1 那种），台标容器整个 GONE
        // —— 不再留一截空位，台名真正靠左（大哥图2 点名）。
        // v1.4.14：回调里主动让台名/节目名重测行程 —— 台标容器 VISIBLE/GONE 会把名字区
        // 挤宽/挤窄，跑马灯行程必须跟着改，否则滚过头盖住台标编号、或末尾露不全（图3/图4 根因）
        val lu = c.logo.orEmpty()
        if (lu.isBlank()) {
            h.logo.setImageDrawable(null)
            h.logoBox.visibility = View.GONE
            h.name.remeasure()
            h.epg.remeasure()
        } else {
            h.logo.load(if (lu.startsWith("http")) lu else Prefs.base + lu) {
                crossfade(false)
                listener(
                    onSuccess = { _, _ ->
                        h.logoBox.visibility = View.VISIBLE
                        h.name.remeasure()
                        h.epg.remeasure()
                    },
                    onError = { _, _ ->
                        h.logoBox.visibility = View.GONE
                        h.name.remeasure()
                        h.epg.remeasure()
                    }
                )
            }
        }

        // 节目单（v1.4.14 按大哥图2 样式改）：一段滚动内容 = 「正在播 xx 几点结束 → 接下来 xx 几点开播」，
        // 滚完正在播接着滚接下来，和图2 参照样式两段信息一致。
        // 后台没配 EPG 就只显示台名，行更清爽
        val e = epg[c.cid]
        if (e == null || e.t.isNullOrBlank()) {
            h.epg.visibility = View.GONE
            h.epg.stopMarquee()
        } else {
            h.epg.visibility = View.VISIBLE
            val sb = StringBuilder("正在播 ").append(e.t)
            if (e.ce > 0) sb.append(" ").append(hhmm(e.ce)).append(" 结束")
            if (!e.next.isNullOrBlank()) {
                sb.append("　接下来 ").append(e.next)
                if (e.ns > 0) sb.append(" ").append(hhmm(e.ns)).append(" 开播")
            }
            h.epg.bindMarquee(sb.toString())
        }

        // 正在播放的这一行：品牌蓝高亮，一眼定位当前台
        h.row.setBackgroundResource(if (c.cid == curCid) R.drawable.bg_row_cur else R.drawable.bg_card)

        bindFocus(h.row)
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
        bindFocus(h.card)
        h.itemView.setOnClickListener { onPick(d) }
    }
}
