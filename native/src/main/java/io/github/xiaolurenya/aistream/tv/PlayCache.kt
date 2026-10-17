package io.github.xiaolurenya.aistream.tv

// 详情页把解析好的线路放到这里，播放器只传索引。
// 不走 Intent：几十条线路几百集塞进 Bundle 容易顶到 Binder 1MB 上限。
object PlayCache {

    // 一条线路 = 某个采集站的某条播放线路 + 它的全部分集
    data class Line(
        val station: String,
        val from: String,
        val eps: List<Api.Episode>
    )

    var lines: List<Line> = emptyList()
    var parseList: List<Api.Parse> = emptyList()
    var hasParse: Boolean = false

    var title: String = ""
    var year: String = ""
    var poster: String = ""
    var itemId: String = ""

    // 与网页端 player.js 的 synthId 完全一致：
    // 同一部片在网页端和原生端落的历史记录是同一个 id，历史/收藏能对上
    fun synthId(t: String, y: String): String {
        var h = 5381
        val str = t + "|" + y
        for (i in str.indices) {
            h = ((h shl 5) + h + str[i].code) or 0
        }
        return "c_" + h.toUInt().toString(36)
    }

    fun progressKey(t: String, ep: Int): String = "$t#$ep"
}
