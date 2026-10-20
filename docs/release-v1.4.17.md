# AIStream TV v1.4.17

大哥投影实拍 3 图点名：右侧推荐卡描边还是偏右、选台列表频道名也在滚、面板顶部节目单不会实时更新识别。全在 `native-tv/`，手机零改动、8890 正式版不动。

## 1. 右侧推荐卡描边错位 → 干脆不放大只描边（图1）
- v1.4.16 已把描边圆角与卡片对齐（10dp）+ 收放大到 1.03，但大哥实测**还是靠右边了**——只要放大，白框就四周悬空一圈、靠屏幕右缘的视觉就是「错位」。
- **根治：侧栏推荐卡焦点放大取消（scale 1.0），只画描边**。2dp 白框 + 10dp 圆角紧贴卡片轮廓，看着就是「框在卡上」，绝无错位、绝无过界。焦点标识的动感由描边 + 提示音承担。

## 2. 选台列表「频道也在滚动」→ 台名改静态（图2）
- 大哥点名：节目信息行该滚，**频道名不该也跟着滚**。
- `ChannelAdapter` 台名从 `bindMarquee(...)` 改为直接赋值（走 `MarqueeTextView.setText` override 自动停跑马灯 = 静态显示）；台标加载回调里的 `name.remeasure()` 一并删掉（那是给跑马灯行程用的，留着会把滚动又注册回来）。
- 台名超宽时显示省略号：`item_channel` 的 tvName 加 `ellipsize="end" + maxLines="1"`；`MarqueeTextView` 不再在 init 里强制 `ellipsize=null`（注册了跑马灯的行走自绘不受影响，静态行 XML 配了省略号就生效）。
- 行内「正在播 xx　接下来 xx」与面板顶部节目单照旧无缝循环滚动（v1.4.16 行为不变）。

## 3. 顶部节目单实时更新识别（图3）
之前顶部「正在播：新闻联播（至 19:33）」只在换台播放那一刻刷一次，之后既不跟焦点走、也不随时间走。两刀：
- **跟焦点走**：`ChannelAdapter` 加 `onFocused` 回调——焦点在列表里挪到哪个台（**没按确认播放也一样**），面板顶部节目单立刻换成那个台的；面板收起清掉焦点台，回到「正在播的台」。
- **跟时间走**：`LiveActivity` 每 60s 后台重拉一次 `/api/iptv`（节目单和频道列表同一接口，包很小），有变化才刷 `PlayCache` + 列表行内节目单（`ChannelAdapter.updateEpg`）+ 面板顶部——节目到点自动换，不再定格在进直播那一刻。周期刷新时若焦点在某个台上，优先显示焦点台的节目单，不顶掉。

---

版本号 1.4.17（versionCode 31）。改动文件：`HomeFragment.kt`（侧栏卡不放大）、`Adapters.kt`（台名静态 + onFocused + updateEpg）、`item_channel.xml`（台名省略号）、`Marquee.kt`（放开 ellipsize）、`LiveActivity.kt`（onFocused/epgTick/focusCid）、`build.gradle.kts`。静态检查三件套全过 bad=0。
