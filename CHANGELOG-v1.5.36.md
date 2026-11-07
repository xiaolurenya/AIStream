# AIStream v1.5.36 更新日志（2026-11-07）

本次为单点缺陷修复版，修复「飞牛 fnOS 桌面快捷方式点开白屏/打不开」，服务端、镜像与 fpk 统一到 **v1.5.36**。

## 修复 · 飞牛桌面快捷方式打不开（iframe 白屏）

**现象**：飞牛应用中心装好 AIStream 后，桌面「AIStream 影视聚合」图标点开是一个空白/破图窗口；但通过容器「8890 访问」链接、或在浏览器手动输入 IP:8890 都能正常打开。

**根因**：fpk 的 `app/ui/config` 把桌面应用声明为 `type: "iframe"`（飞牛以**内嵌 iframe** 方式打开应用，指向容器 `:8890`）。而服务端 `server.js` 此前在**每个响应**都带了 `X-Frame-Options: DENY`——该头会禁止页面被任何 iframe 嵌入，于是飞牛的内嵌窗口被浏览器拒绝渲染 → 白屏/破图。直连浏览器和容器「8890 访问」属于顶层导航（非 iframe），不受此头影响，所以正常。

**修复**：`X-Frame-Options` 改为**仅对 `/api/` 鉴权类接口**保留 `DENY`（防点击劫持，这类接口本就不会被框），主文档与静态资源（HTML/JS/CSS/图片）不再携带该头，飞牛桌面窗口即可正常嵌入。`X-Content-Type-Options` / `Referrer-Policy` 等其他安全头保持不变。

**验证**：`curl -I` 主文档 `GET /` → `200 text/html`，响应头**无** `X-Frame-Options`；`/api/*` 仍有 `X-Frame-Options: DENY`。

## 其他
- `VERSION` 1.5.35 → **1.5.36**；逻辑仅此一处头部调整，无功能改动。
- Docker 镜像保持 **amd64 + arm64 双架构**：`1.5.36` / `v1.5.36` / `latest` 均为多架构 manifest。
- fpk `manifest` 版本号升到 **1.5.36**，compose 镜像 tag 固定为 **`:1.5.36`**（上版 1.5.35 已固定 `:1.5.35`，本版顺延），`upgrade_callback` 含 `docker compose pull` 兜底；飞牛应用中心会向已装用户推送 1.5.36 更新提示。
- 8890（正式站）/ 18897（测试站）双容器已升级到 1.5.36 镜像并验证 `GET /` 可嵌入。
