package io.github.xiaolurenya.aistream.tvbox

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

class App : Application(), ImageLoaderFactory {

    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        Crash.init(this, BuildConfig.VERSION_NAME)
    }

    /* 海报统一走站点图片代理，这里只管缓存：
       电视上 poster 格子大，解码开销高，磁盘缓存给到 150M，第二次进就是本地命中秒开。
       ⚠️ TV 版不做任何模糊处理 —— 大哥要的就是「海报清晰」。 */
    override fun newImageLoader(): ImageLoader = ImageLoader.Builder(this)
        .okHttpClient {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build()
        }
        .memoryCache { MemoryCache.Builder(this).maxSizePercent(0.30).build() }
        .diskCache {
            DiskCache.Builder()
                .directory(cacheDir.resolve("coil"))
                .maxSizeBytes(150L * 1024 * 1024)
                .build()
        }
        .crossfade(160)
        .build()
}
