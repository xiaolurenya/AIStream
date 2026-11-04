#!/usr/bin/env bash
# AIStream 一键更新（保留数据卷 /data，不删容器数据）
#
# 用法（把本文件与 update-cron.sh 放同一目录，compose 或 docker run 部署都行）：
#   bash update.sh            # 拉最新镜像 → 用同一份配置重建容器
#   bash update.sh cron       # 装「宿主机自动更新任务」——装完后台的「一键更新」按钮才可用
#
# 做的事：拉最新镜像 → 用同一份配置重建容器（环境变量、端口、数据卷全部沿用）
# 若你的 compose 文件不叫 docker-compose.yml，把下面的文件名改掉即可。

set -e
cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ 当前目录没有 $COMPOSE_FILE"
  exit 1
fi

# 容器名从 compose 推导（以前写死 aistream，改过名字的人只会看到「未知版本」）
NAME=$(sed -n 's/^ *container_name: *//p' "$COMPOSE_FILE" | tr -d "\"'" | head -1)
[ -n "$NAME" ] || NAME=aistream

# ---------- 子命令：安装宿主机自动更新任务 ----------
if [ "$1" = "cron" ]; then
  CRONSH="$(pwd)/update-cron.sh"
  if [ ! -f "$CRONSH" ]; then
    echo "❌ 缺少 update-cron.sh（应与 $COMPOSE_FILE 放在同一个目录）"
    exit 1
  fi
  chmod +x "$CRONSH"
  LINE="* * * * * /bin/sh $CRONSH >/dev/null 2>&1"
  # 已存在就先去重，避免重复添加
  ( crontab -l 2>/dev/null | grep -vF "$CRONSH" || true; echo "$LINE" ) | crontab -
  echo "✅ 已安装宿主机自动更新任务（每分钟检测一次）"
  crontab -l 2>/dev/null | grep -F "$CRONSH"
  echo "   提示：若 docker 需要 sudo 权限，请用有权限的用户安装（如 sudo crontab -e -u root）"
  echo "   装完后，后台「一键更新」按钮即可使用；不想用可 crontab -e 删掉那一行。"
  exit 0
fi

echo "▶ 1/3 拉取最新镜像 ..."
docker compose pull

echo "▶ 2/3 重建容器（数据卷保留）..."
# v1.5.17 自愈：容器若是 docker run 建的（无 compose 标签），compose 会撞名字冲突直接失败。
# 只有确认它不属于本 compose 项目才删容器 —— 数据卷 / 端口 / 环境变量全部沿用，数据不会丢。
if ! OUT=$(docker compose up -d --remove-orphans 2>&1); then
  if echo "$OUT" | grep -q "already in use"; then
    LBL=$(docker inspect "$NAME" -f '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
    if [ -z "$LBL" ]; then
      echo "⚠️  检测到容器 $NAME 是 docker run 建的，已脱离 compose 管理 —— 这正是更新失败的原因。"
      echo "   将删除该容器并用 compose 重建（数据卷不会动，端口/环境变量全部沿用）。"
      read -r -p "   确认继续？[y/N] " yn
      case "$yn" in
        [yY]*) ;;
        *) echo "已取消，容器未改动"; exit 1 ;;
      esac
      docker rm -f "$NAME" >/dev/null 2>&1 || true
      docker compose up -d --remove-orphans
    else
      echo "$OUT"
      echo "❌ 更新失败（容器名冲突），容器未改动"
      exit 1
    fi
  else
    echo "$OUT"
    echo "❌ 更新失败，容器未受影响"
    exit 1
  fi
fi

echo "▶ 3/3 当前状态："
docker compose ps

VER=$(docker exec "$NAME" cat /app/VERSION 2>/dev/null || echo "未知")
echo "✅ 更新完成，当前版本：v$VER"
echo "   数据目录 /data 未改动；如需回滚：把 VERSION 换成旧 tag 重跑本脚本。"
echo "   想让后台「一键更新」按钮可用，执行一次：bash update.sh cron"
