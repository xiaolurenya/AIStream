package io.github.xiaolurenya.aistream.tvbox

import com.google.gson.GsonBuilder
import com.google.gson.JsonDeserializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

// 站点接口层。所有字段都声明成可空：Gson 走 Unsafe 实例化，
// 缺失字段不会带上 data class 的默认参数值，声明成非空反而会拿到 null 然后在调用处崩。
object Api {

    class Err(msg: String, val code: Int = 0) : Exception(msg)

    // public inline 函数里要用，不能是 private
    @PublishedApi
    internal val gson = GsonBuilder()
        .registerTypeAdapter(String::class.java, JsonDeserializer<String> { j, _, _ ->
            if (j == null || j.isJsonNull) "" else try { j.asString } catch (e: Exception) { "" }
        })
        .create()

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    // 上游检索/解析动辄十几秒（服务端要逐条线路体检+顺延），单独放宽，别挤占普通接口的超时
    private val httpSlow = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(70, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    // ---------- 数据模型 ----------
    data class Card(
        val id: String? = null,
        val title: String? = null,
        val media: String? = null,
        val poster: String? = null,
        val year: String? = null,
        val score: String? = null,
        val station: String? = null
    )

    data class Column(val label: String? = null, val items: List<Card>? = null)

    data class Home(
        val columns: List<Column>? = null,
        val stations: Int = 0,
        val hasUpstream: Boolean = false
    )

    data class Episode(val name: String? = null, val url: String? = null)
    data class Source(val from: String? = null, val episodes: List<Episode>? = null)

    data class Detail(
        val plot: String? = null,
        val actors: String? = null,
        val director: String? = null,
        val type: String? = null,
        val area: String? = null,
        val lang: String? = null,
        val remark: String? = null
    )

    data class PlayRes(
        val station: String? = null,
        val stationId: String? = null,
        val id: String? = null,
        val name: String? = null,
        val year: String? = null,
        val poster: String? = null,
        val remark: String? = null,
        val sources: List<Source>? = null,
        val detail: Detail? = null
    )

    data class Parse(val id: String? = null, val name: String? = null, val url: String? = null)

    data class PlayResp(
        val results: List<PlayRes>? = null,
        val parseList: List<Parse>? = null,
        val hasParse: Boolean = false
    )

    data class SearchResp(val tmdb: List<Card>? = null, val collect: List<PlayRes>? = null)

    data class User(val id: String? = null, val username: String? = null, val role: String? = null)
    data class LoginResp(val token: String? = null, val user: User? = null, val error: String? = null)

    data class HistItem(
        val id: String? = null,
        val title: String? = null,
        val poster: String? = null,
        val year: String? = null,
        val ep: String? = null,
        val epTotal: String? = null,
        val pos: String? = null,
        val dur: String? = null
    )

    data class ListResp(val items: List<HistItem>? = null)
    data class PublicResp(val siteName: String? = null)
    data class OkResp(val ok: Boolean = false, val error: String? = null, val on: Boolean = false)

    // ---------- 基础请求 ----------
    private fun abs(base: String, path: String): String =
        base.trimEnd('/') + (if (path.startsWith("/")) path else "/$path")

    private fun errMsg(body: String, def: String): String {
        return try {
            val o = gson.fromJson(body, LoginResp::class.java)
            val e = o?.error
            if (e.isNullOrBlank()) def else e
        } catch (e: Exception) { def }
    }

    private fun check(code: Int, body: String): String {
        when (code) {
            401 -> throw Err("登录已失效，请重新登录")
            402 -> throw Err("该站点尚未激活授权，请联系站长激活后再用")
            403 -> throw Err(errMsg(body, "管理员没给你的账号开这个权限"))
            429 -> throw Err(errMsg(body, "操作太频繁，等一会儿再试"))
        }
        if (code !in 200..299) throw Err(errMsg(body, "请求失败（HTTP $code）"))
        return body
    }

    private fun deleteRaw(path: String, json: String): String {
        val req = Request.Builder()
            .url(abs(Prefs.base, path))
            .header("Authorization", "Bearer " + Prefs.token)
            .header("Content-Type", "application/json")
            .delete(json.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            return check(r.code, r.body?.string().orEmpty())
        }
    }

    fun getRaw(path: String): String {
        val req = Request.Builder()
            .url(abs(Prefs.base, path))
            .header("Authorization", "Bearer " + Prefs.token)
            .header("Accept", "application/json")
            .build()
        http.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            return check(r.code, body)
        }
    }

    fun getSlowRaw(path: String): String {
        val req = Request.Builder()
            .url(abs(Prefs.base, path))
            .header("Authorization", "Bearer " + Prefs.token)
            .header("Accept", "application/json")
            .build()
        httpSlow.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            return check(r.code, body)
        }
    }

    fun postRaw(path: String, json: String): String {
        val req = Request.Builder()
            .url(abs(Prefs.base, path))
            .header("Authorization", "Bearer " + Prefs.token)
            .header("Content-Type", "application/json")
            .post(json.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            val body = r.body?.string().orEmpty()
            return check(r.code, body)
        }
    }

    const val UA = "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36"

    fun gsonText(o: Any): String = gson.toJson(o)

    // 解析站返回的多半是个网页，ExoPlayer 啃不动，这里自己去把里面的真实地址抠出来
    fun fetchText(url: String): String {
        val req = Request.Builder()
            .url(url)
            .header("User-Agent", UA)
            .header("Accept", "*/*")
            .build()
        http.newCall(req).execute().use { r ->
            val s = r.body?.string().orEmpty()
            if (r.code !in 200..299) throw Err("解析器返回 HTTP ${r.code}")
            return s
        }
    }

    inline fun <reified T> get(path: String): T? =
        try { gson.fromJson(getRaw(path), T::class.java) } catch (e: Err) { throw e } catch (e: Exception) { null }

    inline fun <reified T> getSlow(path: String): T? =
        try { gson.fromJson(getSlowRaw(path), T::class.java) } catch (e: Err) { throw e } catch (e: Exception) { null }

    // ---------- 登录（这一步还没 base，单独传） ----------
    fun login(base: String, user: String, pass: String): LoginResp {
        val body = gson.toJson(mapOf("username" to user, "password" to pass))
        val req = Request.Builder()
            .url(abs(base, "/api/auth/login"))
            .header("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            val s = r.body?.string().orEmpty()
            val o = try { gson.fromJson(s, LoginResp::class.java) } catch (e: Exception) { null }
            when (r.code) {
                401 -> throw Err("用户名或密码错误（连续错 5 次会锁 15 分钟）")
                402 -> throw Err("该站点尚未激活授权")
                429 -> throw Err(o?.error ?: "尝试太频繁，请稍后再试")
            }
            if (r.code !in 200..299) throw Err(o?.error ?: "连接失败（HTTP ${r.code}）")
            if (o == null || o.token.isNullOrBlank()) throw Err("服务器返回异常，没拿到登录凭证")
            return o
        }
    }

    fun publicInfo(base: String): PublicResp? {
        return try {
            val req = Request.Builder().url(abs(base, "/api/public")).build()
            http.newCall(req).execute().use { r ->
                if (r.code !in 200..299) null
                else gson.fromJson(r.body?.string().orEmpty(), PublicResp::class.java)
            }
        } catch (e: Exception) { null }
    }

    // ---------- 业务接口 ----------
    fun home(): Home? = get("/api/home")

    fun search(q: String): SearchResp? = get("/api/search?q=" + enc(q))

    fun playByVid(sid: String, vid: String): PlayResp? =
        get("/api/play?sid=" + enc(sid) + "&vid=" + enc(vid))

    fun playByName(name: String, year: String): PlayResp? {
        var s = "/api/play?name=" + enc(name)
        if (year.isNotBlank()) s += "&year=" + enc(year)
        return get(s)
    }

    fun history(): List<HistItem> = get<ListResp>("/api/history")?.items.orEmpty()

    fun favs(): List<HistItem> = get<ListResp>("/api/fav")?.items.orEmpty()

    fun postHistory(it: HistItem) {
        postRaw("/api/history", gson.toJson(it))
    }

    fun delHistory(id: String) {
        deleteRaw("/api/history", gson.toJson(mapOf("id" to id)))
    }

    fun toggleFav(it: HistItem): Boolean {
        val s = postRaw("/api/fav", gson.toJson(mapOf("add" to it)))
        val o = try { gson.fromJson(s, OkResp::class.java) } catch (e: Exception) { null }
        return o?.on ?: false
    }

    fun isFav(id: String): Boolean = favs().any { it.id == id }

    // ---------- 工具 ----------
    fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")

    // 海报一律走站点图片代理（免登录，顺带绕开图床 Referer 防盗链与跨域）
    fun dimg(raw: String?): String {
        val s = raw.orEmpty().trim()
        if (s.isBlank() || !s.startsWith("http")) return ""
        return Prefs.base + "/api/dimg?u=" + enc(s)
    }

    fun isM3u8(u: String): Boolean =
        Regex("\\.m3u8(\\?|#|$)", RegexOption.IGNORE_CASE).containsMatchIn(u) || u.contains("/hls")

    fun isVideoFile(u: String): Boolean =
        Regex("\\.(mp4|m4v|mkv|webm|ts|flv|mov|avi|m3u8)(\\?|#|$)", RegexOption.IGNORE_CASE)
            .containsMatchIn(u.trim())

    // ---------- 站点配置：功能开关 + 当前账号的可视权限 ----------
    data class IptvCfg(val enabled: Boolean = false, val allowed: Boolean = false)

    data class CfgResp(
        val siteName: String? = null,
        val hasParse: Boolean = false,
        /* ⚠️ 这两张表千万不能声明成 Map<String, Boolean>。
           服务端 config.toggles 里混着字符串（antiScamText）和数字
           （antiScamSpeed / antiScamSize / antiScamFrom / antiScamTo），
           Gson 把数字喂给 Boolean 适配器时会走 JsonReader.nextBoolean()，
           遇到 NUMBER 直接抛 IllegalStateException —— 整个 config 解析报废返回 null。
           后果就是「明明管理员、明明是会员，播放器却提示跳过片头是会员特权」。
           这里统一收成 Any，取值处再按类型判真。 */
        val views: Map<String, Any>? = null,
        val toggles: Map<String, Any>? = null,
        val iptv: IptvCfg? = null
    )

    // 权限/开关表取值：值可能是布尔、数字或字符串，统一按真值判
    fun flag(m: Map<String, Any>?, k: String, def: Boolean): Boolean {
        val x = m?.get(k) ?: return def
        return when (x) {
            is Boolean -> x
            is Number -> x.toInt() != 0
            else -> x.toString().equals("true", ignoreCase = true)
        }
    }

    fun config(): CfgResp? = get("/api/config")

    // ---------- IPTV 直播 ----------
    data class IptvCh(
        val cid: String? = null,
        val name: String? = null,
        val group: String? = null,
        val tid: String? = null,
        val src: String? = null,
        val direct: Boolean = false,
        val logo: String? = null
    )

    /* EPG 节目单（服务端从 xmltv 解析好随 /api/iptv 一起回）：
       t=正在播的节目｜ce=本档结束时间戳｜next=下一档｜ns=下一档开始时间戳 */
    data class EpgNow(val t: String? = null, val ce: Long = 0, val next: String? = null, val ns: Long = 0)

    data class IptvResp(
        val enabled: Boolean = false,
        val denied: Boolean = false,
        val count: Int = 0,
        val total: Int = 0,
        val error: String? = null,
        val channels: List<IptvCh>? = null,
        val now: Map<String, EpgNow>? = null,
        val groupOrder: List<String>? = null
    )

    fun iptv(): IptvResp? = get("/api/iptv")

    // ---------- 插播广告过滤（跟网页版同一套服务端规则） ----------
    /* /api/ad-preview：让服务端按「广告过滤」页同一套规则分析一条播放地址，
       blocked = 命中黑名单的插播段数，discAd = 断点插播段数。 */
    data class AdPreview(
        val blocked: Int = 0,
        val discAd: Int = 0,
        val verdict: String? = null,
        val enabled: Boolean = false,
        val error: String? = null
    )

    fun adPreview(url: String): AdPreview? =
        get("/api/ad-preview?url=" + enc(url) + "&token=" + enc(Prefs.token))

    // 服务端改写清单（去掉插播段、切片保持采集站直链不占上行）。要配合 ?token= 带 AUTH
    fun m3u8FilterUrl(url: String): String =
        Prefs.base + "/api/m3u8filter?url=" + enc(url) + "&token=" + enc(Prefs.token)

    // 频道真实地址不在列表接口里（服务端防窥只给不透明 cid），播放走这个。
    // 网页端 video 标签带不了 header，所以服务端一直就收 ?token=，APP 也走参数、
    // 别把 Bearer 头带给上游 CDN（有些源见到陌生鉴权头会拒）。
    fun iptvStream(cid: String): String =
        Prefs.base + "/api/iptv/stream?ch=" + enc(cid) + "&token=" + enc(Prefs.token)

    // 服务端代理通道：/api/iptv/px 会把清单里的地址再包一层代理由 NAS 代拉。
    // 有些直播源只认服务端出网（浏览器/手机直连就是黑屏），直连播不动时走这条兜底。
    fun iptvStreamPx(cid: String): String =
        Prefs.base + "/api/iptv/px?u=" + enc(iptvStream(cid)) + "&token=" + enc(Prefs.token)

    // ---------- 上游资源库（网页端换源面板里那二十几条线路的来源） ----------
    // 没配上游的站点这三个接口会返回 noUpstream / 空，调用方要安静降级到采集站聚合。
    data class UpItem(
        val id: String? = null,
        val title: String? = null,
        val normalized_title: String? = null,
        val poster_url: String? = null,
        val year: String? = null
    )

    data class UpSearchResp(val items: List<UpItem>? = null)

    fun upSearch(q: String): UpSearchResp? = getSlow("/api/up/search?q=" + enc(q) + "&limit=8")

    data class UpEp(
        val id: String? = null,
        val title: String? = null,
        val name: String? = null,
        val episode_title: String? = null,
        val number: String? = null,
        val token: String? = null,
        val playback_token: String? = null
    )

    fun epToken(e: UpEp?): String = e?.token.orEmpty().ifBlank { e?.playback_token.orEmpty() }

    fun epName(e: UpEp?, i: Int): String =
        (e?.title ?: e?.name ?: e?.episode_title).orEmpty().ifBlank { "第 " + (i + 1) + " 集" }

    data class UpEps(
        val episodes: List<UpEp>? = null,
        val items: List<UpEp>? = null,
        val list: List<UpEp>? = null
    )

    data class UpPg(val total: Int = 0, val limit: Int = 0, val pages: Int = 0, val has_more: Boolean = false)

    data class UpDetailData(
        val title: String? = null,
        val normalized_title: String? = null,
        val poster_url: String? = null,
        val year: String? = null,
        val overview: String? = null,
        val description: String? = null,
        val content_kind: String? = null,
        val kind: String? = null,
        val type: String? = null
    )

    data class UpDetailResp(
        val detail: UpDetailData? = null,
        val episodes: UpEps? = null,
        val noUpstream: Boolean = false,
        val quick: Boolean = false,
        val cached: Boolean = false,
        val pagination: UpPg? = null
    )

    // quick=true 走 phase=1（服务端只回第一页分集先让播起来）；慢在这两个接口上，超时放宽
    fun upDetail(id: String, quick: Boolean): UpDetailResp? =
        getSlow("/api/up/detail?id=" + enc(id) + (if (quick) "&phase=1" else ""))

    data class UpLine(
        val label: String? = null,
        val official: Boolean? = null,
        val selected: Boolean? = null,
        val weight: Int = 0,
        val type: String? = null,
        val url: String? = null
    )

    data class UpResolveResp(
        val url: String? = null,
        val label: String? = null,
        val official: Boolean? = null,
        val error: String? = null,
        val total: Int = 0,
        val lines: List<UpLine>? = null
    )

    // 服务端已经做好：拉黑过滤 → 上游 selected 置顶 → 权重降序 → 官方兜底，
    // 还会自己顺延最多 8 条体检不过的线路，APP 拿到的就是「该用的那条」
    fun upResolve(token: String, skip: Int, keep: String?): UpResolveResp? {
        var s = "/api/up/resolve?token=" + enc(token)
        if (skip > 0) s += "&skip=" + skip
        if (!keep.isNullOrBlank()) s += "&keep=" + enc(keep)
        return getSlow(s)
    }

    // 换源面板的全线路列表：debug=1 只列出不真播，服务端有缓存，开销很小
    fun upLineList(token: String): UpResolveResp? =
        getSlow("/api/up/resolve?token=" + enc(token) + "&debug=1")

    // ---------- 会员 / 积分 / 邀请 ----------
    data class VipInfo(
        val level: String? = null,
        val name: String? = null,
        val noAds: Boolean = false,
        val pointMul: String? = null,
        val expire: String? = null,
        val days: String? = null
    )

    data class CheckinInfo(val today: Boolean = false, val streak: String? = null, val last: String? = null)
    data class InviteInfo(val code: String? = null, val invited: String? = null, val perInvite: String? = null)
    data class DailyInfo(val watchMin: String? = null, val date: String? = null)

    data class PointsResp(
        val points: String? = null,
        val vip: VipInfo? = null,
        val checkin: CheckinInfo? = null,
        val invite: InviteInfo? = null,
        val daily: DailyInfo? = null
    )

    fun pointsMe(): PointsResp? = get("/api/points/me")
    fun invite(): InviteInfo? = get("/api/invite")

    data class CheckinResp(
        val ok: Boolean = false,
        val gained: String? = null,
        val streak: String? = null,
        val points: String? = null,
        val msg: String? = null,
        val error: String? = null
    )

    fun checkin(): CheckinResp? =
        try { gson.fromJson(postRaw("/api/checkin", "{}"), CheckinResp::class.java) } catch (e: Exception) { null }

    data class RedeemItem(
        val id: String? = null,
        val title: String? = null,
        val desc: String? = null,
        val kind: String? = null,
        val level: String? = null,
        val permKey: String? = null,
        val days: String? = null,
        val cost: String? = null,
        val stock: String? = null,
        val soldOut: Boolean = false
    )

    data class RedeemMe(val points: String? = null, val vip: VipInfo? = null)
    data class RedeemResp(val enabled: Boolean = false, val items: List<RedeemItem>? = null, val me: RedeemMe? = null)

    fun redeem(): RedeemResp? = get("/api/redeem")
    fun redeemPost(id: String): OkResp? =
        try { gson.fromJson(postRaw("/api/redeem", gsonText(mapOf("id" to id))), OkResp::class.java) }
        catch (e: Exception) { null }

    // ---------- 账号 ----------
    fun changePassword(oldPw: String, newPw: String) {
        postRaw("/api/auth/change-password", gsonText(mapOf("oldPassword" to oldPw, "newPassword" to newPw)))
    }

    fun logout() {
        try { postRaw("/api/auth/logout", "{}") } catch (e: Exception) {}
    }

    fun register(user: String, pass: String, invite: String): LoginResp {
        val body = gsonText(mapOf("username" to user, "password" to pass, "invite" to invite))
        val req = Request.Builder()
            .url(abs(Prefs.base, "/api/auth/register"))
            .header("Content-Type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { r ->
            val s = r.body?.string().orEmpty()
            val o = try { gson.fromJson(s, LoginResp::class.java) } catch (e: Exception) { null }
            if (r.code !in 200..299) throw Err(o?.error ?: "注册失败（HTTP ${r.code}）")
            if (o == null || o.token.isNullOrBlank()) throw Err("注册返回异常")
            return o
        }
    }

    // ---------- 投屏 ----------
    // 服务端 v36 已经把 SSDP 发现和 SOAP 控制都做了，手机端只负责列设备、发指令
    data class DlnaDev(
        val name: String? = null,
        val controlUrl: String? = null,
        val location: String? = null,
        val type: String? = null
    )

    data class DlnaList(val list: List<DlnaDev>? = null, val error: String? = null)

    fun dlnaScan(): DlnaList? = get("/api/dlna/scan")

    fun dlnaCast(controlUrl: String, url: String, title: String): OkResp? =
        try {
            gson.fromJson(
                postRaw("/api/dlna/cast", gsonText(mapOf("controlUrl" to controlUrl, "url" to url, "title" to title))),
                OkResp::class.java
            )
        } catch (e: Exception) { null }

    fun dlnaStop(controlUrl: String): OkResp? =
        try {
            gson.fromJson(postRaw("/api/dlna/stop", gsonText(mapOf("controlUrl" to controlUrl))), OkResp::class.java)
        } catch (e: Exception) { null }
}
