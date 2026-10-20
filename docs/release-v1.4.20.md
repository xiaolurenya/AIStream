# AIStream TV v1.4.20

大哥投影实拍 2 图点名：首页 hero 大海报「还是模糊，就像拉扯放大了一样，人物都没显示全；你看别人的海报清晰度，应该是海报显示的方式或者逻辑有问题」。

## 双根因（都实锤了）

1. **服务端豆瓣卡片取的是小缩略图**：`server.js` doubanToUp 里 `poster_url: x.pic.normal || x.pic.large` —— **normal 优先**。豆瓣 normal 是列表小图（宽仅一两百像素），hero 全屏一拉就是近十倍放大，糊成马赛克。这就是「像拉扯放大了一样」的真正来源。
2. **客户端 hero 把竖版海报 centerCrop 硬铺满宽屏容器**：竖版 2:3 海报铺进约 1.9:1 的 hero，宽度放大 2~3 倍的同时上下被裁掉一大截 —— 「人物都没显示全」。

## 修法

### 服务端（GitHub 分发版 server.js，一行）
- `pic.normal || pic.large` → **`pic.large || pic.normal`**：豆瓣 large 原图优先，TV / 手机 / 网页全端海报清晰度一起根治（hero、网格、详情页全受益）。
- `node --check` 通过。⚠️ 8890 正式容器（aivideo_live/）没动 —— 那边同样有这行，等大哥发话再同步 + 重建镜像。

### 客户端 hero 重排（native-tv）
- **新增前景 `heroPoster`**：右侧锚定、高 = hero 高、`fitCenter` 原比例完整展示 —— 海报全貌、人物完整、清晰（这就是「别人的海报」的显示方式：横版剧照/原比例海报，不硬拉）。
- **背景层 `heroBg` 定性为氛围底**：保留 centerCrop 但代码里加 `RenderEffect` 磨砂（18f，API31+）—— 竖版海报拉宽屏必然放大，索性虚化成有意的衬底，不再「假清晰」；左侧渐变压暗（bg_scrim_left）保留，标题/立即播放照旧在左下。
- `paintHero` 同一张图两层出（bg + 前景）；直播预览小窗开/关时 heroPoster 与 heroBg 同步显隐。
- `heroDots` 轮播圆点从右下挪到**底部居中**（右侧被清晰海报占了，避免叠在海报上）。

## 效果对照
- 之前：豆瓣小缩略图 → 全屏拉宽 ≈10 倍 → 糊 + centerCrop 裁掉头脚。
- 现在：豆瓣 large 原图 → 右侧原比例完整清晰展示，背景磨砂氛围 + 渐变压暗。

---

版本号 1.4.20（versionCode 34）。改动文件：`server.js`（1 行 + 注释）、`HomeFragment.kt`、`fragment_home.xml`、`build.gradle.kts`。`node --check` + 静态三件套全过。
