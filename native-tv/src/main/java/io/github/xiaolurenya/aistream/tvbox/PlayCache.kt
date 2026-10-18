package io.github.xiaolurenya.aistream.tvbox

// 详情页把解析好的线路放到这里，播放器只传索引。
// 不走 Intent：几十条线路几百集塞进 Bundle 容易顶到 Binder 1MB 上限。
object PlayCache {

    // 一条线路 = 某个采集站的某条播放线路 + 它的全部分集
    data class Line(
        val station: String,
        val from: String,
        val eps: List<Api.Episode>
    )

    // 官方 / 专享这类线路排前面（跟网页端一个口径）
    private val OFFICIAL = Regex("官方|专享|腾讯|爱奇艺|优酷|芒果|咪咕|闪电|极速|vip", RegexOption.IGNORE_CASE)

    fun isOfficial(l: Line): Boolean = OFFICIAL.containsMatchIn(l.station) || OFFICIAL.containsMatchIn(l.from)

    // 稳定排序：官方在前，其余保持后台配置顺序
    fun sorted(list: List<Line>): List<Line> = list.sortedBy { if (isOfficial(it)) 0 else 1 }

    var lines: List<Line> = emptyList()
    var parseList: List<Api.Parse> = emptyList()
    var hasParse: Boolean = false

    // 当前选中的解析器下标（后台可以配多条解析线路，用户可挑一条）
    var parseIndex: Int = 0

    // ---------- 上游资源库模式（站点配了上游时走这条，网页端那 24 条线路就是它给的） ----------
    // 上游模式和采集模式不一样：分集是同一份，线路是解析时动态挑的，
    // 所以分集列表和线路列表分开存，线路只记「当前用第几条」。
    var isUp: Boolean = false
    var upEps: List<Api.UpEp> = emptyList()
    var upLines: List<Api.UpLine> = emptyList()
    var upSkip: Int = 0            // 线路下标：0 = 智能选择（官方优先，失败自动顺延）
    var upKind: String = ""        // content_kind：电影不自动跳片头（跟网页端同一口径）

    fun clearUp() {
        isUp = false
        upEps = emptyList()
        upLines = emptyList()
        upSkip = 0
        upKind = ""
    }

    // 电影不【自动】跳片头：网页端按 content_kind 判，采集模式没有 kind 就按「单集即电影」判
    fun isMovie(eps: Int): Boolean {
        val k = upKind.lowercase()
        if (k.contains("movie") || k.contains("film") || k.contains("电影")) return true
        return eps <= 1
    }

    // IPTV 频道列表与当前台号：直播播放页要能上下换台
    var iptv: List<Api.IptvCh> = emptyList()
    var iptvIndex: Int = 0

    fun parseUrl(): String = parseList.getOrNull(parseIndex)?.url.orEmpty()

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
