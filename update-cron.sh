#!/bin/sh
# AIStream 一键更新 · 宿主机侧任务（每分钟由 crontab 调起）
#
# 作用：检测容器写来的更新请求文件 → 在本 compose 目录执行 pull + up -d → 结果回写。
# 容器里没有 docker CLI，删自己建自己只能由宿主机代劳，所以这个任务是「一键更新」的另一半。
#
# 安装（一次性）：
#   1) 把本文件放在 docker-compose.yml 同一个目录
#   2) 加一条 crontab（每分钟）：
#        * * * * * /bin/sh /你的目录/update-cron.sh >/dev/null 2>&1
#      更省事：在 compose 目录执行  bash update.sh cron  （自动装好并去重）
#   ⚠️ 需要能操作 docker 的用户（NAS 上通常是 sudo crontab -e，或用 root）
#
# 安全点：pull 失败绝不动容器（旧容器照常跑）；数据卷全程不碰；
#        只有确认是「脱离 compose 管理的同名容器」时才会删容器（不删数据）。

set -u

WEB=$(cd "$(dirname "$0")" && pwd)
COMPOSE="$WEB/docker-compose.yml"
[ -f "$COMPOSE" ] || exit 0

# 数据目录与容器名全部从 compose 推导，不写死，任何人的部署都能直接用
DATA=$(sed -n 's/.*- *\(\/[^:]*\):\/data.*/\1/p' "$COMPOSE" | head -1)
NAME=$(sed -n 's/^ *container_name: *//p' "$COMPOSE" | tr -d "\"'" | head -1)
[ -n "$DATA" ] || exit 0
[ -n "$NAME" ] || NAME=aistream

REQ="$DATA/.aistream-update-request"
RES="$DATA/.aistream-update-result"
LOG=/tmp/aistream-update.log

[ -f "$REQ" ] || exit 0
[ -f "$RES.lock" ] && exit 0          # 上一次还没跑完
touch "$RES.lock" 2>/dev/null || exit 0
echo "{\"ok\":null,\"startedAt\":\"$(date +%s)\"}" > "$RES"

{
  echo "==== $(date '+%F %T') 收到更新请求 ===="
  cat "$REQ"; echo
} >> "$LOG"

cd "$WEB" 2>/dev/null || {
  echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"compose 目录 $WEB 不存在，容器未动\"}" > "$RES"
  rm -f "$REQ" "$RES.lock"
  exit 1
}

# 自愈：容器若是 docker run 建的（无 compose 标签），compose up -d 会撞名字冲突。
# 这里只在「确认它不属于本 compose 项目」时才删容器 —— 数据卷不动，服务不丢数据。
fix_conflict() {
  LBL=$(docker inspect "$NAME" -f '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
  [ -n "$LBL" ] && return 1
  echo "发现容器 $NAME 脱离 compose 管理（docker run 建的），删除后用 compose 重建（数据卷不动）" >> "$LOG"
  docker rm -f "$NAME" >> "$LOG" 2>&1 || return 1
  return 0
}

if docker compose pull >> "$LOG" 2>&1 && docker compose up -d >> "$LOG" 2>&1; then
  :
else
  # 撞名字冲突 → 自愈后重试一次
  if grep -q "already in use" "$LOG" 2>/dev/null && fix_conflict; then
    docker compose pull >> "$LOG" 2>&1
    if docker compose up -d >> "$LOG" 2>&1; then
      :
    else
      echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"pull/up 执行失败（已尝试自愈），旧容器未受影响；详见宿主机 $LOG\"}" > "$RES"
      echo "==== $(date '+%F %T') 更新失败（容器未动） ====" >> "$LOG"
      rm -f "$REQ" "$RES.lock"
      exit 1
    fi
  else
    echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"pull/up 执行失败，旧容器未受影响；详见宿主机 $LOG\"}" > "$RES"
    echo "==== $(date '+%F %T') 更新失败（容器未动） ====" >> "$LOG"
    rm -f "$REQ" "$RES.lock"
    exit 1
  fi
fi

NEWV=$(docker exec "$NAME" cat /app/VERSION 2>/dev/null | tr -d ' \n')
echo "{\"ok\":true,\"finishedAt\":\"$(date +%s)\",\"to\":\"$NEWV\",\"msg\":\"更新完成，当前 v$NEWV\"}" > "$RES"
echo "==== $(date '+%F %T') 更新完成: v$NEWV ====" >> "$LOG"
rm -f "$REQ" "$RES.lock"
