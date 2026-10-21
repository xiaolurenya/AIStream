plugins {
    id("com.android.application") version "8.4.1"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

/* 固定签名：CI 注入了密钥库就用它签（和手机版同一把钥匙，这样 TV 版以后升级也能直接覆盖安装）。
   别人 fork 自己编译没有密钥库时退回 debug 签名，构建照样过得了。
   密钥库本身不进仓库，走 Actions Secret。 */
val ksFile = System.getenv("AISTREAM_KEYSTORE").orEmpty()
val hasKs = ksFile.isNotBlank() && file(ksFile).exists()

android {
    namespace = "io.github.xiaolurenya.aistream.tvbox"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.xiaolurenya.aistream.tvbox"
        minSdk = 24
        targetSdk = 34
        versionCode = 38
        versionName = "1.4.24"
    }

    signingConfigs {
        if (hasKs) {
            create("aistream") {
                storeFile = file(ksFile)
                storePassword = System.getenv("AISTREAM_KS_PW").orEmpty()
                keyAlias = System.getenv("AISTREAM_KEY_ALIAS").orEmpty()
                keyPassword = System.getenv("AISTREAM_KEY_PW").orEmpty()
            }
        }
    }

    buildTypes {
        getByName("debug") {
            if (hasKs) signingConfig = signingConfigs.getByName("aistream")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (hasKs) signingConfigs.getByName("aistream") else signingConfigs.getByName("debug")
        }
    }

    // AGP 8 起默认不再生成 BuildConfig（配置页要显示版本号）
    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.viewpager2:viewpager2:1.1.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")

    // 播放器（官方 ExoPlayer 后继）
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.4.1")

    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("io.coil-kt:coil:2.6.0")
}
