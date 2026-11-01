# AIStream 老部署迁移指南（docker run → compose 自动更新）

> 适用：早期用 `docker run` 命令手动起容器的用户。
> 迁移完成即可获得「**面板点重启 = 自动更新到最新版**」能力，且迁移完直接就是最新版，不需要一个个版本升。
> 已用 docker-compose.yml 部署的用户**不需要**看本文，直接在面板点「重启 / 重新部署」即可自动更新。

## 原理

自动更新靠的是 compose 里的两个配置：

```yaml
image: xiaoluya/aistream:latest
pull_policy: always   # 每次启动都先拉最新镜像
```

飞牛面板对 compose 项目的「重启 / 重新部署」会执行 `docker compose up -d`，配合 `pull_policy: always` 就会先拉最新镜像再重建容器。普通 `docker run` 容器没有这个机制，`docker restart` 只是重启进程，永远不会换镜像。

## 迁移步骤（一次性，约 2 分钟）

### 1. 备份数据目录

先确认你的数据目录在哪（旧容器挂载的 `/data`），在飞牛「文件管理」里整个复制一份，例如：

```
/vol1/1000/aistream/data  →  /vol1/1000/aistream/data-bak
```

只要这个目录还在，所有配置、用户、收藏都不会丢。

### 2. 记下旧容器的端口和特殊环境变量

```bash
docker inspect 旧容器名 --format '{{json .HostConfig.PortBindings}} {{json .Config.Env}}'
```

记下宿主机端口（如 `8890`、`18897`）以及是否设置过 `LICENSE_OFF=1` 等变量。

### 3. 停止并删除旧容器（不删数据目录）

```bash
docker rm -f 旧容器名
```

⚠️ 只删容器，**不要删数据目录**。删错了从 data-bak 还原即可。

### 4. 新建目录，放入 docker-compose.yml

从仓库下载 `docker-compose.yml`（https://github.com/xiaolurenya/AIStream ），放到一个新目录，例如 `/vol1/1000/xdocker/aistream/`，然后按需修改：

```yaml
services:
  aistream:
    image: xiaoluya/aistream:latest
    pull_policy: always                    # 保持不动，这是自动更新的关键
    container_name: aistream
    user: "0:0"
    restart: always
    ports:
      - "8890:8890"                        # ← 左边改成你原来的宿主机端口
    environment:
      - TZ=Asia/Shanghai
      - PORT=8890
      - DATA_DIR=/data
      # - LICENSE_OFF=1                    # ← 旧容器有就取消注释
    volumes:
      - /vol1/1000/aistream/data:/data     # ← 左边改成你原来的数据目录
```

### 5. 启动并验证

```bash
cd /vol1/1000/xdocker/aistream
docker compose up -d
docker exec aistream cat /app/VERSION    # 应显示最新版本号
```

浏览器打开站点确认正常，后台「概览」能看到当前版本。

### 6. 确认无误后删除备份

跑几天没问题后，把 `data-bak` 删掉即可。

## 以后的日常更新

三选一：

1. **面板点「重启 / 重新部署」**（推荐，自动拉最新镜像）
2. SSH 执行 `bash update.sh`（compose 目录下，一键拉取+重建）
3. 后台出现「有新版本」角标时，操作同 1

## 想用后台「一键更新」按钮？（v1.5.17 起）

按钮的原理是：容器往数据目录写一个请求文件 → **宿主机**上的定时任务检测到后执行 `docker compose pull && up -d`（容器里没有 docker，自己更新不了自己）。
所以这套任务默认**没有装**，不装的话按钮点了不会有反应、只会等到超时。

装一次即可（compose 目录下执行）：

```bash
bash update.sh cron
```

它会自动把同目录的 `update-cron.sh` 加进 crontab（每分钟检测一次，重复执行会自动去重）。

- 若提示权限不足，改用有 docker 权限的用户安装：`sudo crontab -e`，粘贴这一行：

```cron
* * * * * /bin/sh /你的compose目录/update-cron.sh >/dev/null 2>&1
```

- 不想用了：`crontab -e` 删掉那一行即可，容器不受影响。
- 任务日志在宿主机 `/tmp/aistream-update.log`，更新失败时看它。
- 安全设计：拉镜像失败绝不动容器；只有确认容器脱离 compose 管理时才会删容器重建，**数据卷全程不碰**。

## 回滚

把 compose 里的 `image` 改成旧版本 tag（如 `xiaoluya/aistream:v1.4.28`）后 `docker compose up -d`；数据异常时用 data-bak 还原数据目录。
