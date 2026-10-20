package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.graphics.Canvas
import android.os.SystemClock
import android.util.AttributeSet
import android.view.Choreographer
import android.text.BufferType
import androidx.appcompat.widget.AppCompatTextView

/* v1.4.14 跑马灯再修（MarqueeTextView 自绘裁剪）。
   v1.4.12/13 两版「translationX 平移 + 外壳 clipChildren 裁剪」在真机上仍有回归（大哥投影 4 图点名）：
   ① 台标是 Coil 异步加载，成功回调把台标容器 GONE→VISIBLE 会把名字区挤宽/挤窄，
      而跑马灯行程只在 bind 时量一次 → dist 时大时小：大了滚过头（文字左端越出壳，
      视觉上盖住台标甚至前面的编号方块，图3/图4），小了末尾的字永远露不全（「…后面没显示全」）；
   ② 每次条目复用 dist 忽大忽小、相位重置，看起来频道在乱跳。
   这版彻底换思路 —— 不再把 View 平移出边界靠父壳裁剪，而是：
   - View 恒为 match_parent（= 名字区宽），View 本身永远不会越界去碰编号/台标；
   - onDraw 里自己 canvas.clipRect(0,0,w,h) + translate(-offset) 自绘文字，
     文字怎么滚都被裁在 View 自己的边界里，物理上不可能遮挡旁边任何控件；
   - 每一轮滚回开头时重新量宽（remeasure），台标异步挤宽/挤窄自动适配，dist 永远是准的
     （Coil 加载回调里也会主动触发一次重测，第一轮就是准的）；
   - 文字没超宽（CCTV1 这种短名）绝不注册调度，一帧都不动。
   节奏：开头停 1.2s（读全名）→ 匀速滚到末尾最后一字完整可见（行程 = 真实超宽，一字不少）
   → 末尾停 0.8s（读结尾）→ 回开头。全程 View 内始终有字、无空窗。
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
        private const val START_HOLD = 1200L   // 开头停：读得清完整台名
        private const val END_HOLD = 800L      // 末尾停：读得清结尾
        private const val SPEED_DP = 42f       // 每秒 42dp，电视上不紧不慢

        private fun tickFrame() {
            val now = SystemClock.uptimeMillis()
            val dt = (now - lastTs).coerceIn(0L, 100L)
            lastTs = now
            val it = ALL.iterator()
            var alive = 0
            while (it.hasNext()) {
                val m = it.next()
                if (!m.isAttachedToWindow || m.dist <= 0f) {
                    m.offset = 0f
                    m.invalidate()
                    it.remove()
                    continue
                }
                m.phase += dt
                val p = m.phase
                m.offset = when {
                    p < START_HOLD -> 0f
                    p < START_HOLD + m.scrollMs -> m.dist * ((p - START_HOLD) / m.scrollMs)
                    p < START_HOLD + m.scrollMs + END_HOLD -> m.dist
                    else -> {
                        // 一轮滚完回开头：宽度可能变过（台标异步加载挤压名字区），重量一次
                        m.phase = 0L
                        m.remeasure()
                        0f
                    }
                }
                m.invalidate()
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

    private var dist = 0f      // 文本超出的像素宽（要滚的全程）
    private var scrollMs = 0f  // 滚完全程需要的毫秒数
    private var phase = 0L     // 当前周期内的毫秒位置
    private var offset = 0f    // 已滚过的像素（文字向左平移量，自绘用）

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
        dist = 0f
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
            val tw = paint.measureText(text?.toString().orEmpty())
            val over = tw - avail
            if (over <= 2f) {
                // 短文字不滚（CCTV1 这类），复位成普通静态显示
                ALL.remove(this)
                dist = 0f
                scrollMs = 0f
                phase = 0L
                offset = 0f
                invalidate()
                return@post
            }
            if (over != dist) phase = 0L   // 宽变了从头来，别拿旧相位跳变（乱跳的根因之一）
            dist = over
            scrollMs = over / (SPEED_DP * resources.displayMetrics.density) * 1000f
            offset = 0f
            ALL.remove(this)
            ALL.add(this)
            kick()
        }
    }

    /* 直接 setText 赋值（不走 bindMarquee）= 静态文本，自动停掉跑马灯，
       避免「节目单暂无信息」这类短文案还挂在调度器里 */
    override fun setText(text: CharSequence?, type: BufferType) {
        ALL.remove(this)
        dist = 0f
        scrollMs = 0f
        phase = 0L
        offset = 0f
        super.setText(text, type)
    }

    override fun onDraw(canvas: Canvas) {
        if (dist <= 0f) {
            super.onDraw(canvas)
            return
        }
        // 自绘：裁在自身边界内再平移，文字永远出不了这个 View，绝不可能盖到编号/台标
        canvas.save()
        canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
        canvas.translate(-offset, 0f)
        val fm = paint.fontMetrics
        val baseline = height / 2f - (fm.ascent + fm.descent) / 2f
        canvas.drawText(text?.toString().orEmpty(), paddingLeft.toFloat(), baseline, paint)
        canvas.restore()
    }
}
