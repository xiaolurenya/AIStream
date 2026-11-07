# AIStream v1.5.34 更新日志（2026-11-07）

本次为缺陷修复版，修复两个线上 Bug，服务端、手机端、TV 端、fpk 与 Docker 镜像统一到 **v1.5.34**。

## 修复 1 · TV 端预览小窗「有声音无图像」

**现象**：TV 端详情页预览小画面只出声、不出画面；点「全屏播放」再返回预览小窗就恢复正常。

**根因**：TV 端用的是全站唯一共享播放器 `PlayerHolder`（单例 ExoPlayer）。`startPreviewPlayer()` 首播时只调了 `PlayerHolder.play()`（加载+出声），**没有把预览 `PlayerView` 绑定到共享播放器**（`pv.player` 未设置）。音频播放不需要 SurfaceView 渲染目标，所以能出声却黑窗；而全屏 → 返回时 `onResume → attachPreview()` 会补绑 `PlayerView`，因此「往返一次」后才正常。

**修复**：详情页**首播即** `PlayerHolder.attach(pv, muted = true, loop = true)`，预览窗从一开始就被绑到共享播放器。预览与全屏现在共用同一个 ExoPlayer，音画同步、切全屏/返回均秒切不重播。

## 修复 2 · 手机 / TV 点进采集站栏目取不到分类

**现象**：手机 APP 和 TV 端，点进任意采集站栏目都拉不到栏目分类（后台和网页端都能正常拿到）。

**根因**：客户端的 `Api.Column` 数据模型**缺少 `cats` 字段**，Gson 在反序列化时把服务端下发的整份分类目录**静默丢弃**；两端从未渲染过分类芯片，自然永远只显示「全部」。

**修复**：
- 模型新增 `Cat(id, name)` 与 `Column.cats`，并新增 `Api.homeCat(idx, t, page)` 走 `/api/home/cat` 按分类拉取。
- TV 端 `CategoryActivity` 渲染分类芯片（横向 Chip），点选走 `homeCat`；空分类走 `fallback` 兜底。
- 手机端 `HomeFragment` 渲染分类芯片（`ChipAdapter`），「全部」用 `col.items`，其余走 `homeCat`。
- 布局补齐 `rvCats` / `tvEmpty` / `rvHomeCats` 等 ID。

## 其他
- 服务端镜像随本版统一到 **v1.5.34**（仅版本号随行，服务端逻辑未变）。
- Docker 镜像继续提供 **amd64 + arm64 双架构**，`latest` / `v1.5.34` / `1.5.34` 均为多架构 manifest。
- fpk 重打包，`manifest` 版本升到 **1.5.34**，飞牛应用中心会向已装用户推送更新提示。
- 版本号对齐：服务端 `VERSION=1.5.34`；手机 `versionName=1.5.34` / `versionCode=22`；TV `versionName=1.5.34` / `versionCode=60`。

## 升级方式
- **飞牛应用中心**：打开应用中心即可看到「有更新」，一键升级（fpk 版本号已升档）。
- **手动**：重启容器即因 `pull_policy: always` 拉到最新 `:latest`；或 `docker compose pull && up -d`。
- **APP**：同签名正式包，已装旧版可直接覆盖安装，无需卸载。
