# AIStream TV v1.4.23（含服务端 v1.4.23 剧照字段）

大哥打回 v1.4.22（截图）：「一个大窗口怎么弄的只有这么小的海报」——hero 窗口那么大，竖版海报只占右边一条，环境色补底再顺眼也改变不了海报小的事实。

## 根子与出路

竖版海报天生 2:3，宽幅 hero（≈16:9 更宽）里 fitCenter 只有三种下场：占一条（小）、放大裁切（人物不全）、铺满拉伸（变形）。**客户端无解，出路在数据源**——hero 该用横版剧照，这是所有影视首页「大横幅」的标准做法。

## 修法：服务端补横版剧照，hero 整幅铺满

**服务端（server.js，分发版）**
- 新增 `doubanBackdrop(dbId)`：走豆瓣 rexxar `movie/{id}/photos?type=S` 拿剧照，`image` 是千像素级大图（全幅不糊）；剧照有横有竖，优先挑 `width>height` 的横版；每部 24h 缓存（走 doubanJson 统一缓存）；失败返回空串。
- `homeColItems` 豆瓣栏目第一页给前 8 张卡并发补 `backdrop` 字段；单部失败不影响整栏。
- `/api/home` 响应体多了可选 `backdrop`，网页/手机端不认识这个字段，零影响。

**TV 客户端（HomeFragment）**
- `Api.Card` 加 `backdrop: String?`（可空，Gson 安全）。
- `paintHero` 优先级：**有剧照 → `paintBackdrop` 整幅铺满**（clear 原图 centerCrop，只轻微裁边、人物完整；标题/按钮照旧压左侧渐变）→ 没剧照 → `paintPoster`（v1.4.22 的右侧原比例 + 环境色补底兜底）。
- 剧照加载失败自动退回海报方案，hero 不空屏；轮播圆点/预览小窗逻辑不变（`heroWide` 形态位复用）。

## 效果
大窗口一幅大剧照铺满，又大又清晰，标题压在左边渐变上——就是「别人家」首页的样子。没有剧照的片目自动退回 v1.4.22 的海报方案，任何情况不空屏。

---

版本号 1.4.23（versionCode 37）。改动：`server.js`（doubanBackdrop + 补字段）、`HomeFragment.kt`（paintBackdrop/paintPoster 拆分）、`Api.kt`（Card.backdrop）、`build.gradle.kts`。
