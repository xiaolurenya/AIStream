plugins {
    id("com.android.application") version "8.4.1"
    id("org.jetbrains.kotlin.android") version "1.9.24"
}

android {
    namespace = "io.github.xiaolurenya.aistream"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.xiaolurenya.aistream"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
