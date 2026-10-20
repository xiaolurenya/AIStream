package io.github.xiaolurenya.aistream.tvbox

import android.os.SystemClock
import android.view.Choreographer
import android.view.View
import android.widget.TextView

/* v1.4.13 跑马灯修正。v1.4.12 自绘跑马灯有三个回归（大哥投影点名）：
   ① 短台名（CCTV1 这种）本不该滚却滚了；
   ② 面板节目单 / 台名没跑完（行程算短了，末尾露不全）；
   ③ 单行台名滚过头、把前面的三位编号挡住（行程算大了）。
   根因：bind() 用 match_parent 的 TextView.tvWidth 当「可用宽」，RecyclerView 回收/快速滚动时
   这个宽度量不准（时大时小），溢出判定与行程全跟着错。
   本办法：
   - TextView 改 wrap_content（自身宽度 = 文字宽，永不依赖布局宽度做判定）；
   - 可用宽一律取自外层裁剪壳 box 的宽度（布局完成后量，稳定）；
   - 文字宽用 paint 直量；仅当「文字宽确实 > 可用宽」才注册跑马灯，短文字绝不滚。
   节奏 = 开头停 1.2s（读全名）→ 匀速滚到文本末尾完整可见（行程 = 文字真实超出宽，一字不少）
   → 末尾停 0.8s（读结尾）→ 回到开头。全程行内始终有字，不空窗。
   平移用 translationX，外层 FrameLayout(clipChildren=true) 负责裁剪；续帧用「函数 + 每帧新
   lambda」，避免 val 存 FrameCallback 自引用被 Kotlin 报 recursive problem / must be initialized。 */
class MarqueeLabel(private val tv: TextView, private val box: View? = null) {

    companion object {
        private val ALL = ArrayList<MarqueeLabel>()
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
                if (!m.tv.isAttachedToWindow || m.dist <= 0f) {
                    m.tv.translationX = 0f
                    it.remove()
                    continue
                }
                m.phase += dt
                val p = m.phase
                m.tv.translationX = when {
                    p < START_HOLD -> 0f
                    p < START_HOLD + m.scrollMs -> -m.dist * ((p - START_HOLD) / m.scrollMs)
                    p < START_HOLD + m.scrollMs + END_HOLD -> -m.dist
                    else -> { m.phase = 0L; 0f }
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

    private var dist = 0f      // 文本超出的像素宽（要滚的全程）
    private var scrollMs = 0f  // 滚完全程需要的毫秒数
    private var phase = 0L     // 当前周期内的毫秒位置

    /* 绑定新文本：先复位停掉旧的，等布局完成后量可用宽与文字宽，真溢出才进调度器 */
    fun bind(text: CharSequence?) {
        stop()
        tv.text = text
        tv.post {
            if (!tv.isAttachedToWindow) return@post
            // 可用宽取自裁剪壳宽度（稳定），兜底用 tv 自身宽度
            val boxW = (box?.width ?: tv.width).toFloat()
            val avail = boxW - tv.paddingLeft - tv.paddingRight
            if (avail <= 2f) return@post
            val tw = tv.paint.measureText(text?.toString().orEmpty())
            val over = tw - avail
            if (over <= 2f) { tv.translationX = 0f; return@post }   // 短文字不滚
            dist = over
            scrollMs = over / (SPEED_DP * tv.resources.displayMetrics.density) * 1000f
            phase = 0L
            tv.translationX = 0f
            ALL.remove(this)
            ALL.add(this)
            kick()
        }
    }

    fun stop() {
        ALL.remove(this)
        dist = 0f
        scrollMs = 0f
        phase = 0L
        tv.translationX = 0f
    }
}
