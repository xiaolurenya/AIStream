package io.github.xiaolurenya.aistream

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

/** 启动路由：配置过服务器 → 直接进 WebView；否则进「添加服务器」页 */
class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sp = getSharedPreferences("aistream", MODE_PRIVATE)
        val target = if (sp.getString("server", null) != null) {
            Intent(this, WebActivity::class.java)
        } else {
            Intent(this, ServerSetupActivity::class.java)
        }
        startActivity(target)
        finish()
    }
}
