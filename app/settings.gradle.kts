pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "AIStream"
/* 单模块工程：根目录本身就是 :app 模块（build.gradle.kts 在同级），不要再 include 子模块 */

