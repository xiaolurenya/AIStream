# AIStream v1.5.43

## 新增
- **本地媒体源（本地目录媒体源）**：直接扫描 NAS / 服务器上的影视文件夹建库，浏览器经 AIStream 自带流式接口播放，无需 Emby / 网盘直链 / 第三方工具。
  - 后台「本地媒体源」面板：启用、栏目显示名称、媒体根目录、转封装开关、测试目录连通性、扫描建库。
  - 扫描自动分类：电影（单文件按文件夹名）/ 剧集（季文件夹或 S01E01 / 第N集 等分集命名），并生成首页栏目与 AppleCMS 兼容的 CMS 接口（`/api/localmedia/cms`）。
  - 播放：`mp4 / webm / mov` 浏览器原生播放；`mkv / avi / ts` 等开启「转封装」后由服务端 ffmpeg 实时复制流转为 mp4 流式输出。
  - 流式端点 `/api/localmedia/file` 支持 Range（断点续传 / 拖拽进度），含路径穿越防护。
- 权限：本地媒体源作为虚拟站接入，可像采集站一样按用户 / 会员等级控制显隐（键 `station:localmedia`）。

## 移除
- 移除后台「Emby 媒体库」入口（放弃 Emby 直连方案，本地媒体源为其替代）。后端 Emby 相关代码暂保留，后续可清理。

## 升级提示
- 仅更新镜像即可（compose 默认 `:latest`）。
- 若走飞牛应用中心分发：打 fpk 时务必把 `manifest` 的 `version` 升一档，且桌面入口 `app/ui/config` 保持端口服务模式（`type:"url", protocol:"http", port:8890, url:"/"`），勿用 iframe / 网关模式（否则桌面图标打开 404）。
