# AIStream TV v1.4.19

大哥投影实拍点名六项，全部修复：

1. 暂时找不到片源 → 加「刷新重试」按钮
2. 播放影视/直播刚起播 → 显示视频分辨率浮层
3. 选中首页栏目 → 立即弹出栏目墙（之前要双击/确认）
4. 详情页大海报太模糊 → 降模糊强度
5. 直播/影视放着放着进屏保 → 播放时常亮
6. IPTV 播放界面方向键响应随机 → 改成确定性导航

---

## ① 暂无片源加「刷新重试」
- `activity_detail.xml`：`tvPlot` 下方新增 `btnRetry`（默认 `gone`，样式同主按钮）。
- `DetailActivity.kt`：`settle()` 空结果分支把 `btnRetry` 显示出来；新增 `retryLoad()` 清空本次失败结果 + 清掉该片的详情缓存（避免 quiet 静默刷新把空结果又喂回来）+ 重置加载状态重新 `load()`。`onResume` 那条「缓存命中直进」分支不受影响。

## ② 起播显示分辨率
- 两个播放页（`PlayerActivity` / `LiveActivity`）的 ExoPlayer 监听里加 `onVideoSizeChanged(VideoSize)`，取到宽高后折算成 `4K / 1080P / 720P`，不够档位显示 `宽×高`。
- 布局 `activity_player.xml` / `activity_live.xml` 各加一个 `tvRes` 浮层（右上角、品牌色胶囊），刚出画面显示，**3.5s 后自动消失**，不挡操作。

## ③ 首页栏目选中后立即弹出
- `Adapters.kt` 的 `ColumnAdapter.onBindViewHolder`：原先只有「点击/确认」弹栏目墙，现在 `bindFocus(h.label) { has -> if (has) tryOpen(col.idx) }`——**D-pad 聚焦（选中）即弹**。
- 防回弹守卫：① 创建后 / 每次 `HomeFragment.onResume` 调 `armGuard()` 后 1.2s 内不自动开（防进应用误开、防从栏目墙返回焦点落回标题又瞬间重开）；② 同一栏目 1.5s 内重复聚焦不重开（返回时焦点刚好回到刚开的那个标题，命中这层）。
- `HomeFragment.onResume` 调用 `adapter.armGuard()`。

## ④ 详情页大海报降模糊
- `DetailActivity.loadBackdrop` 的 `RenderEffect.createBlurEffect` 半径 **22f → 12f**（API31+）：保留磨砂感但能看清本片海报轮廓（大哥点名「大海报太模糊」）。选集面板那张是另一处、不动。

## ⑤ 播放/直播防屏保
- `PlayerActivity` / `LiveActivity` 的 `onCreate` 加 `window.addFlags(FLAG_KEEP_SCREEN_ON)`：放着放着盒子进屏保的根治。

## ⑥ IPTV 方向键确定性导航
- `LiveActivity.dispatchKeyEvent` 面板开着时把每一项方向键指名道姓，不再丢给系统默认焦点搜索乱跳：
  - **确认/ENTER** = 播放「当前聚焦」的台（焦点在频道列表才接管；在分组列交给系统切分组、在搜索框继续输入）；
  - **左** = 从频道列表跳到左侧分组列（换分组）；已在分组/搜索框不乱跳；
  - **右** = 从分组列/搜索框回到频道列表；
  - **上下** = 列表/分组都是单列竖排，交给系统单列表内移动；焦点若在搜索框则直接落进频道列表，不卡输入框；
  - **返回/菜单** = 收面板。
- 新增 `focusIn()` / `focusedChannelPos()` / `pickFocusedChannel()` / `focusCats()` 辅助：按确认永远播「焦点所在那一行」，不再不知道选到哪。

---

版本号 1.4.19（versionCode 33）。改动文件：`DetailActivity.kt`、`HomeFragment.kt`、`Adapters.kt`、`PlayerActivity.kt`、`LiveActivity.kt`、`build.gradle.kts`、布局 `activity_detail.xml` / `activity_player.xml` / `activity_live.xml`。静态检查三件套全过 bad=0。
