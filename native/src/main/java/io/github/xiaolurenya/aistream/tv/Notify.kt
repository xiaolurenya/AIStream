package io.github.xiaolurenya.aistream.tv

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/* 实时推送通道（跟网页版同一条服务端 SSE：/api/stream）。
   管理员在后台发的「广播」「公告」会立刻推到这 —— 之前只有网页版能收，
   两个 APP 都没接这条，大哥后台发通知 APP 这边没反应，就是这原因。
   断线 3 秒自动重连；同一内容只弹一次（连上时服务端会补推当前公告）。 */
object Notify {

    // 广播/公告的数据体：字段名跟网页版 app.js 一一对应
    data class Push(
        val title: String? = null,
        val content: String? = null,
        val time: Long = 0,
        val enabled: Boolean = true,
        val mode: String? = null
    )

    private class Msg(val type: String? = null, val data: Push? = null)

    private var job: Job? = null
    private val seen = HashSet<String>()

    // show: (标题, 内容) —— 由调用方（Activity）负责弹窗
    fun start(scope: CoroutineScope, show: (String, String) -> Unit) {
        stop()
        job = scope.launch {
            while (isActive) {
                try {
                    withContext(Dispatchers.IO) {
                        Api.sseConnect { raw -> handle(raw, show) }
                    }
                } catch (e: Exception) {
                    // 断线/没网/服务端没开：安静重连，别打扰用户
                }
                delay(3000)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    private fun handle(raw: String, show: (String, String) -> Unit) {
        // ⚠️ Gson 整树反序列化：任一字段类型不匹配整个 fromJson 就抛异常，
        // 这里 runCatching 吞掉——但 Push 字段全可空 + Long，服务端字段变动最多是缺字段
        val m = runCatching { Api.gson.fromJson(raw, Msg::class.java) }.getOrNull() ?: return
        if (m.type != "broadcast" && m.type != "announcement") return
        val d = m.data ?: return
        if (m.type == "announcement" && !d.enabled) return
        val title = d.title.orEmpty()
        val content = d.content.orEmpty()
        if (title.isBlank() && content.isBlank()) return
        val key = title + "|" + content + "|" + d.time
        synchronized(seen) { if (!seen.add(key)) return }
        show(if (title.isBlank()) "公告" else title, content)
    }
}
