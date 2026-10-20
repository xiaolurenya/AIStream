package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.graphics.Canvas
import android.os.SystemClock
import android.util.AttributeSet
import android.view.Choreographer
import android.widget.TextView
import androidx.appcompat.widget.AppCompatTextView

/* 跑马灯（v1.4.16 定稿：无缝循环滚动）。
   v1.4.14 换成 MarqueeTextView 自绘裁剪后，遮挡编号/叠台标/露不全/乱跳已根治；
   v1.4.15 又把回程改平滑 + 重绘节流。但大哥实测点名：**滚完滚回开头（回弹）不对，
   要的是一直循环的滚动** —— 即文字向左滚出、从右边再进来，永不停歇，像新闻条。
   v1.4.16 实现（无缝循环的经典做法）：
   - 一轮行程 = 文字实宽 tw + 段间空隙 gap，offset 在 [0, tw+gap) 内循环推进；
   - onDraw 画**两份**文字：x1 = pad - offset（正在退出左边），x2 = x1 + tw + gap
     （正从右边跟进）。offset 到达 tw+gap 时相位归零，此刻 x2 恰好走到 x1 的位置，
     视觉上完全无缝 —— 永远有字在滚，没有空窗、没有回弹；
   - 首次 bind 仍停 START_HOLD 1.2s（先让人读一遍开头），之后无限循环不再停顿；
   - 重绘节流 ~30fps（FRAME_MS）保留，低端盒子不掉帧；
   - View 恒 match_parent + clipRect 自绘裁剪不变，物理上不可能遮挡编号/台标；
   - 短文字（不超宽）不注册，静态显示。
   续帧仍用「私有函数 + 每帧新 lambda」—— val 存 FrameCallback 在 lambda 里自引用会被
   Kotlin 拒编译（recursive problem / must be initialized，CI 实锤过）。 */
class MarqueeTextView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : AppCompatTextView(context, attrs) {

    companion object {
        private val ALL = ArrayList<MarqueeTextView>()
        private var ticking = false
        private var lastTs = 0L
        private const val START_HOLD = 1200L   // 首轮开头停：读得清完整文字（只停这一次）
        private const val SPEED_DP = 42f       // 每秒 42dp，电视上不紧不慢
        private const val GAP_DP = 48f         // 循环两份文字之间的空隙
        private const val FRAME_MS = 32L       // 重绘节流到 ~30fps：视觉顺滑，低端盒子开销减半

        private fun tickFrame() {
            val now = SystemClock.uptimeMillis()
            val dt = (now - lastTs).coerceIn(0L, 100L)
            lastTs = now
            val it = ALL.iterator()
            var alive = 0
            while (it.hasNext()) {
                val m = it.next()
                if (!m.isAttachedToWindow || m.loop <= 0f) {
                    m.offset = 0f
                    m.invalidate()
                    it.remove()
                    continue
                }
                m.phase += dt
                // 起始停顿之后进入无限循环：offset 在 [0, loop) 内转圈（% 就是循环本体）
                val off = if (m.phase < START_HOLD) 0f
                else ((m.phase - START_HOLD) % m.scrollMs) / m.scrollMs * m.loop
                // ~30fps 节流重绘：相位照算，重绘降频——盒子掉帧的直接救
                m.acc += dt
                if (m.acc >= FRAME_MS) {
                    m.acc = 0L
                    if (off != m.offset) { m.offset = off; m.invalidate() }
                }
                alive++
            }
            if (alive > 0) Choreographer.getInstance().postFrameCallback { tickFrame() }
            else ticking = false
        }

        private fun kick() {
            if (ticking) return
            ticking = true
            lastTs = SystemClock.uptimeMillis()
            Choreographer.getInstance().postFrameCallback { tickFrame() }
        }
    }

    private var tw = 0f       // 文字实宽（onDraw 画两份要用，remeasure 时量好存下）
    private var loop = 0f     // 一轮循环行程 = 文字宽 + 段间空隙
    private var scrollMs = 0f // 滚完一轮循环需要的毫秒数
    private var phase = 0L    // 当前周期内的毫秒位置
    private var offset = 0f   // 已滚过的像素（文字向左平移量，自绘用）
    private var acc = 0L      // 重绘节流累计器

    init {
        // 文字显示全权交给自绘，关掉 TextView 自带的省略/跑马灯行为
        ellipsize = null
    }

    /* 绑定文本并（重）量宽。注册了跑马灯后走自绘；没超宽就是普通静态 TextView */
    fun bindMarquee(text: CharSequence?) {
        stopMarquee()
        setText(text)
        remeasure()
    }

    fun stopMarquee() {
        ALL.remove(this)
        tw = 0f
        loop = 0f
        scrollMs = 0f
        phase = 0L
        offset = 0f
        invalidate()
    }

    /* 量宽：布局完成后按「文字实宽 vs View 可用宽」判定；宽度变了自动修正行程。
       public —— 台标异步加载挤压名字区时，回调里直接调它让行程立刻跟上 */
    fun remeasure() {
        post {
            if (!isAttachedToWindow) return@post
            val avail = (width - paddingLeft - paddingRight).toFloat()
            if (avail <= 2f) return@post
            val w = paint.measureText(text?.toString().orEmpty())
            val over = w - avail
            if (over <= 2f) {
                // 短文字不滚（CCTV1 这类），复位成普通静态显示
                ALL.remove(this)
                tw = 0f
                loop = 0f
                scrollMs = 0f
                phase = 0L
                offset = 0f
                invalidate()
                return@post
            }
            if (over != loop) phase = 0L   // 宽变了从头来，别拿旧相位跳变（乱跳的根因之一）
            tw = w
            loop = w + GAP_DP * resources.displayMetrics.density
            scrollMs = loop / (SPEED_DP * resources.displayMetrics.density) * 1000f
            offset = 0f
            acc = 0L
            ALL.remove(this)
            ALL.add(this)
            kick()
        }
    }

    /* 直接 setText 赋值（不走 bindMarquee）= 静态文本，自动停掉跑马灯，
       避免「节目单暂无信息」这类短文案还挂在调度器里。
       ⚠️ BufferType 是 TextView 的嵌套枚举（TextView.BufferType），CI 实锤不是 android.text 的 */
    override fun setText(text: CharSequence?, type: TextView.BufferType) {
        ALL.remove(this)
        tw = 0f
        loop = 0f
        scrollMs = 0f
        phase = 0L
        offset = 0f
        super.setText(text, type)
    }

    override fun onDraw(canvas: Canvas) {
        if (loop <= 0f) {
            super.onDraw(canvas)
            return
        }
        // 自绘：裁在自身边界内再平移，文字永远出不了这个 View，绝不可能盖到编号/台标。
        // 循环精髓：同时画两份 —— 第一份正在退出左边，第二份贴着段间空隙从右边跟进，
        // offset 转完一圈归零时第二份恰好接到第一份的位置，视觉无缝永不停。
        canvas.save()
        canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        canvas.translate(-offset, 0f)
        val fm = paint.fontMetrics
        val baseline = height / 2f - (fm.ascent + fm.descent) / 2f
        val t = text?.toString().orEmpty()
        val x1 = paddingLeft.toFloat()
        canvas.drawText(t, x1, baseline, paint)
        canvas.drawText(t, x1 + tw + GAP_DP * resources.displayMetrics.density, baseline, paint)
        canvas.restore()
    }
}
