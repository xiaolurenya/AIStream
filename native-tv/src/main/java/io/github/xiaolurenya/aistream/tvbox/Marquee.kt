package io.github.xiaolurenya.aistream.tvbox

import android.os.SystemClock
import android.view.Choreographer
import android.widget.TextView

/* v1.4.12 跑马灯重做。系统自带的 marquee 三宗罪（大哥投影实测点名）：
   ① 每个 TextView 各挂一条动画回调，选台列表一屏十几个同时滚，低端盒子掉帧卡顿；
   ② 一轮滚完要等整行文字全走空、再从右边慢慢爬回来 —— 看起来「左边一大半是空的」；
   ③ 速度和行程不可控，长台名滚一半像没滚（「滚动距离不够」）。
   这里改成集中调度：全局只有一条帧回调，按帧时间差统一推进所有跑马灯（60fps 恒速）。
   一轮节奏 = 开头停 1.2s（读得清完整台名）→ 匀速滚到文本末尾完整可见
   （行程 = 文本真实超出宽度，一字不少）→ 末尾停 0.8s（读得清结尾）→ 回到开头。
   全程行内始终有字，不再出现空窗期。没超宽的短文字不注册、不占帧。
   文字移动用 translationX，外层 FrameLayout（clipChildren=true）负责裁剪。 */
class MarqueeLabel(private val tv: TextView) {

    companion object {
        private val ALL = ArrayList<MarqueeLabel>()
        private var ticking = false
        private var lastTs = 0L
        private const val START_HOLD = 1200L   // 开头停：读得清完整台名
        private const val END_HOLD = 800L      // 末尾停：读得清结尾
        private const val SPEED_DP = 42f       // 每秒 42dp，电视上不紧不慢

        private val frame = Choreographer.FrameCallback {
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
            if (alive > 0) Choreographer.getInstance().postFrameCallback(frame) else ticking = false
        }

        private fun kick() {
            if (ticking) return
            ticking = true
            lastTs = SystemClock.uptimeMillis()
            Choreographer.getInstance().postFrameCallback(frame)
        }
    }

    private var dist = 0f      // 文本超出的像素宽（要滚的全程）
    private var scrollMs = 0f  // 滚完全程需要的毫秒数
    private var phase = 0L     // 当前周期内的毫秒位置

    /* 绑定新文本：先复位停掉旧的，等布局完成后量超宽，超了才进调度器 */
    fun bind(text: CharSequence?) {
        stop()
        tv.text = text
        tv.post {
            if (!tv.isAttachedToWindow) return@post
            val avail = (tv.width - tv.paddingLeft - tv.paddingRight).toFloat()
            if (avail <= 0f) return@post
            val over = tv.paint.measureText(text?.toString().orEmpty()) - avail
            if (over <= 1f) return@post
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
