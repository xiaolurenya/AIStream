# 升级到 v1.4.28（一次性操作，做完以后再也不用删容器）

> 适用于 **v1.4.27 及更早版本**：飞牛 / 群晖 / 宝塔 / 任意 Docker 机器都通用。
> **核心原则：只删「容器」，绝对不删「数据目录 / 数据卷」。**

---

## ⚠️ 开工前：先备份数据目录（2 分钟，保险）

在飞牛「文件管理」里，把你挂给容器的 data 目录整个复制一份，例如：

```
/vol1/1000/aistream/data      →  复制成  /vol1/1000/aistream/data-bak-20261027
```

里面有：`config.json`（站点配置）、`users.json`（用户）、`history.json`（观看历史）、`reserve.json`（预约）。
只要这个目录还在，你所有配置和用户都不会丢。

---

## 第一步：停掉并删除旧容器（不删数据）

**飞牛面板**

1. 打开「Docker」→「容器」
2. 找到 `aistream` → 点「停止」
3. 点「删除」——删除对话框里**不要勾任何"同时删除数据 / 删除挂载目录"的选项**
4. 确认后容器消失，但你宿主机上的 data 目录仍然在（自己刷新文件管理确认一下）

**命令行**

```bash
docker stop aistream
docker rm aistream          # 只删容器，/data 挂载目录不受影响
```

---

## 第二步：用新版 compose 重新创建（这一步做完就永久自动更新）

**飞牛面板**

1. 「Docker」→「项目 / Compose」→「新建项目」
2. 项目名填 `aistream`，路径选一个**空目录**（例如 `/vol1/1000/aistream`）
3. 粘贴下面这份 compose（把数据目录路径改成你自己的）

```yaml
services:
  aistream:
    image: xiaoluya/aistream:latest
    # 关键一行：每次「重启/重新部署」都会先拉最新镜像
    pull_policy: always
    container_name: aistream
    restart: unless-stopped
    ports:
      - "8890:8890"
    environment:
      - TZ=Asia/Shanghai
      - PORT=8890
      - DATA_DIR=/data
    volumes:
      # ←← 只改这一行左边：改成你自己的 data 目录
      - /vol1/1000/aistream/data:/data
```

4. 点「部署 / 启动」

**命令行**

```bash
mkdir -p /opt/aistream && cd /opt/aistream
# 把上面的 compose 存成 docker-compose.yml（改好数据目录路径）
docker compose up -d --pull always
```

> 需要 DLNA 投屏的，把 `ports:` 两行换成 `network_mode: host`。

---

## 第三步：验证

1. 浏览器打开 `http://你的IP:8890`，能看到站点、能登录
2. 后台 →「概览」，右下角应显示 **当前版本 v1.4.28**
3. 用户、历史、收藏、预约都在（因为它们全在 data 目录里，没动过）

---

## 以后怎么更新（再也不用删容器）

| 你的习惯 | 怎么做 |
|---|---|
| 手动点一下 | 面板点「重启 / 重新部署」→ 自动拉最新镜像 |
| 跑一条命令 | `bash update.sh`（仓库自带）或 `docker compose up -d --pull always` |
| 完全不管 | 叠加 `docker-compose.auto-update.yml`（watchtower），每小时自检自动更新 |

```bash
# 完全自动（一次配置，永久生效）
docker compose -f docker-compose.yml -f docker-compose.auto-update.yml up -d
```

---

## 出问题怎么回滚

```bash
# 1) 换回旧镜像 tag（比如 v1.4.27）
sed -i 's#xiaoluya/aistream:latest#xiaoluya/aistream:v1.4.27#' docker-compose.yml
docker compose up -d
# 2) 还不行就把 data-bak 复制回去（先停容器）
```

---

## 一句话总结

- **只删容器，不删数据目录** → 数据零风险
- 换成新版 compose（带 `pull_policy: always`）→ 以后点「重启」就等于更新
- 升级后**永远不需要再删容器**
