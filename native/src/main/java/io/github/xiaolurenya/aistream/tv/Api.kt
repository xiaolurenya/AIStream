package io.github.xiaolurenya.aistream.tv

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
}
