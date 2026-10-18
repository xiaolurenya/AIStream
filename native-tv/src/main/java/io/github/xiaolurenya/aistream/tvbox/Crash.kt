package io.github.xiaolurenya.aistream.tvbox

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.util.Log
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/* 崩溃兜底：把未捕获异常写进本机 crash.log，下次开 APP 直接弹出来。
   大哥在外面用手机，没法连电脑抓 logcat；有个能一键复制的堆栈，
   问题基本一轮就能定位。 */
object Crash {

    private const val FILE = "crash.log"
    private const val KEY_AT = "crash_at"
    private const val KEY_N = "crash_n"

    fun init(app: Context, version: String) {
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching {
                val sw = StringWriter()
                e.printStackTrace(PrintWriter(sw))
                val head = "APP v$version | Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT}) | ${Build.MODEL}"
                File(app.filesDir, FILE).writeText("$head\n\n$sw")
                val sp = app.getSharedPreferences("aistream", Context.MODE_PRIVATE)
                sp.edit().putLong(KEY_AT, System.currentTimeMillis())
                    .putInt(KEY_N, sp.getInt(KEY_N, 0) + 1).apply()
            }
            runCatching { prev?.uncaughtException(t, e) }
        }
    }

    // 取出并清掉日志；没有就返回空串
    fun take(ctx: Context): String {
        val f = File(ctx.filesDir, FILE)
        if (!f.exists()) return ""
        val s = runCatching { f.readText() }.getOrDefault("")
        runCatching { f.delete() }
        return s
    }

    // 有崩溃日志就弹窗（可滚动 + 可复制），返回 true 表示弹了
    fun showIfAny(act: Activity): Boolean {
        val txt = take(act)
        if (txt.isBlank()) return false

        val pad = (14 * act.resources.displayMetrics.density).toInt()
        val tv = TextView(act).apply {
            text = txt
            textSize = 11f
            setTextIsSelectable(true)
            setPadding(pad, pad, pad, pad)
            setTextColor(act.getColor(R.color.fg))
        }
        val sv = ScrollView(act).apply { addView(tv) }

        AlertDialog.Builder(act)
            .setTitle("上次运行时崩溃了")
            .setView(sv)
            .setPositiveButton("复制") { d, _ ->
                val cm = act.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newPlainText("crash", txt))
                d.dismiss()
            }
            .setNegativeButton("关闭", null)
            .setCancelable(false)
            .show()
        return true
    }

    // 崩溃次数（用于判断是否陷入「一启动就崩」的循环）
    fun count(ctx: Context): Int =
        ctx.getSharedPreferences("aistream", Context.MODE_PRIVATE).getInt(KEY_N, 0)

    fun reset(ctx: Context) {
        ctx.getSharedPreferences("aistream", Context.MODE_PRIVATE).edit()
            .putInt(KEY_N, 0).remove(KEY_AT).apply()
    }
}
