package io.github.xiaolurenya.aistream.tv

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity

// 收藏 / 观看历史的容器页：从「我的」里点进来
class ListActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_list)

        val mode = intent.getStringExtra("mode") ?: "history"
        title = if (mode == "fav") "我的收藏" else "观看历史"

        val f = if (mode == "fav") FavFragment() else HistoryFragment()
        supportFragmentManager.beginTransaction()
            .replace(R.id.container, f)
            .commit()
    }
}
