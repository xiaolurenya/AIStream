#!/usr/bin/env bash
# AIStream 一键更新（保留数据卷 /data，不删容器数据）
#
# 用法：在 docker-compose.yml 所在目录执行
#   bash update.sh
#
# 做的事：拉最新镜像 → 用同一份 compose 重建容器（环境变量、端口、数据卷全部沿用）
# 若你的 compose 文件不叫 docker-compose.yml，把下面的文件名改掉即可。

set -e
cd "$(dirname "$0")"

COMPOSE_FILE="docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "❌ 当前目录没有 $COMPOSE_FILE"
  exit 1
fi

echo "▶ 1/3 拉取最新镜像 ..."
docker compose pull

echo "▶ 2/3 重建容器（数据卷保留）..."
docker compose up -d --remove-orphans

echo "▶ 3/3 当前状态："
docker compose ps

VER=$(docker exec aistream cat /app/VERSION 2>/dev/null || echo "未知")
echo "✅ 更新完成，当前版本：v$VER"
echo "   数据目录 /data 未改动；如需回滚：把 VERSION 换成旧 tag 重跑本脚本。"
