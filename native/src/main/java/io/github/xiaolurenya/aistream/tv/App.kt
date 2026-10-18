package io.github.xiaolurenya.aistream.tv

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

    /* 海报统一走站点图片代理，这里只管缓存与加载节奏。
       磁盘缓存给到 120M：首页几十张海报第二次进就是本地命中，秒开。 */
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
                .maxSizeBytes(120L * 1024 * 1024)
                .build()
        }
        // 160ms 淡入：比默认快一截，滑动时不拖影
        .crossfade(160)
        .build()
}
