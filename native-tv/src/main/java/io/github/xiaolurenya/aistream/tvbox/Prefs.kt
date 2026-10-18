package io.github.xiaolurenya.aistream.tvbox

import android.content.Context
import android.content.SharedPreferences

object Prefs {

    private const val F = "aistream_tv"
    private const val FP = "aistream_tv_progress"
    private lateinit var sp: SharedPreferences
    private lateinit var spProg: SharedPreferences

    fun init(c: Context) {
        if (!::sp.isInitialized) {
            sp = c.applicationContext.getSharedPreferences(F, Context.MODE_PRIVATE)
            spProg = c.applicationContext.getSharedPreferences(FP, Context.MODE_PRIVATE)
        }
    }

    var base: String
        get() = sp.getString("base", "") ?: ""
        set(v) { sp.edit().putString("base", v.trim().trimEnd('/')).apply() }

    var proto: String
        get() = sp.getString("proto", "http") ?: "http"
        set(v) { sp.edit().putString("proto", v).apply() }

    var host: String
        get() = sp.getString("host", "") ?: ""
        set(v) { sp.edit().putString("host", v.trim()).apply() }

    var port: String
        get() = sp.getString("port", "8890") ?: "8890"
        set(v) { sp.edit().putString("port", v.trim()).apply() }

    var user: String
        get() = sp.getString("user", "") ?: ""
        set(v) { sp.edit().putString("user", v).apply() }

    var pass: String
        get() = sp.getString("pass", "") ?: ""
        set(v) { sp.edit().putString("pass", v).apply() }

    var token: String
        get() = sp.getString("token", "") ?: ""
        set(v) { sp.edit().putString("token", v).apply() }

    var siteName: String
        get() = sp.getString("siteName", "") ?: ""
        set(v) { sp.edit().putString("siteName", v).apply() }

    // 首页中间区域打开时的样子：true = 直接播 IPTV 直播小窗，false = 显示大海报（默认）
    var heroLive: Boolean
        get() = sp.getBoolean("hero_live", false)
        set(v) { sp.edit().putBoolean("hero_live", v).apply() }

    val configured: Boolean
        get() = base.isNotBlank() && token.isNotBlank()

    fun clear() {
        sp.edit().clear().apply()
    }

    // ---- 本地续播进度：只存本机，播放时优先用它，起播后再同步服务端历史 ----
    fun putProgress(key: String, pos: Long, dur: Long) {
        if (dur <= 0) return
        spProg.edit().putString(key, "$pos|$dur|${System.currentTimeMillis()}").apply()
    }

    fun getProgress(key: String): Pair<Long, Long> {
        val s = spProg.getString(key, "") ?: ""
        if (s.isBlank()) return 0L to 0L
        val a = s.split("|")
        val pos = a.getOrNull(0)?.toLongOrNull() ?: 0L
        val dur = a.getOrNull(1)?.toLongOrNull() ?: 0L
        return pos to dur
    }

    fun dropProgress(key: String) {
        spProg.edit().remove(key).apply()
    }
}
