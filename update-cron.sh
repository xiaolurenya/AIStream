#!/bin/sh
# AIStream 一键更新 · 宿主机侧任务（每分钟由 crontab 调起）
#
# 作用：检测容器写来的更新请求文件 → 拉最新镜像 → 用同一份配置重建容器 → 结果回写。
# 同时支持两种部署方式（不用改任何配置）：
#   A) compose 部署（本目录有 docker-compose.yml）→ docker compose pull + up -d
#   B) docker run 部署（没有 compose 文件）→ 找到运行中的 xiaoluya/aistream 容器，
#      从 docker inspect 还原运行参数（数据卷 / 端口 / 环境变量 / 重启策略 / 网络 / 用户）
#      用同名容器重建，数据卷始终保留，服务不丢数据。
#
# 安装（一次性，compose 与 docker run 部署都适用）：
#   1) 把本文件与 update.sh 放在同一目录（任意目录都行）
#   2) 装 crontab（每分钟）：  bash update.sh cron
#   ⚠️ 需要能操作 docker 的用户（NAS 上通常是 sudo crontab -e，或用 root）
#
# 安全点：pull 失败绝不动容器（旧容器照常跑）；只有确认要重建时才删旧容器，
#        且数据卷全程不碰；compose 下「撞名冲突」也只在确认容器脱离 compose 管理时才删。

set -u

WEB=$(cd "$(dirname "$0")" && pwd)
COMPOSE="$WEB/docker-compose.yml"

REQ=""; RES=""; LOG=/tmp/aistream-update.log
MODE=""

# ---------- 模式探测 ----------
detect_compose() {
  [ -f "$COMPOSE" ] || return 1
  DATA=$(sed -n 's/.*- *\(\/[^:]*\):\/data.*/\1/p' "$COMPOSE" | head -1)
  NAME=$(sed -n 's/^ *container_name: *//p' "$COMPOSE" | tr -d "\"'" | head -1)
  [ -n "$DATA" ] || return 1
  [ -n "$NAME" ] || NAME=aistream
  return 0
}
detect_run() {
  NAME=$(docker ps --filter "ancestor=xiaoluya/aistream" --format '{{.Names}}' 2>/dev/null | head -1)
  [ -n "$NAME" ] || NAME=$(docker ps --filter "ancestor=xiaoluya/aistream:latest" --format '{{.Names}}' 2>/dev/null | head -1)
  [ -n "$NAME" ] || return 1
  DATA=$(docker inspect "$NAME" -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null | head -1)
  [ -n "$DATA" ] || return 1
  return 0
}

if detect_compose; then MODE=compose
elif detect_run; then MODE=run
else exit 0   # 既没 compose 也没运行中的容器 → 静默退出，不误删任何东西
fi

REQ="$DATA/.aistream-update-request"
RES="$DATA/.aistream-update-result"

[ -f "$REQ" ] || exit 0
[ -f "$RES.lock" ] && exit 0
touch "$RES.lock" 2>/dev/null || exit 0
echo "{\"ok\":null,\"startedAt\":\"$(date +%s)\"}" > "$RES"

{
  echo "==== $(date '+%F %T') 收到更新请求（mode=$MODE, name=$NAME）===="
  cat "$REQ"; echo
} >> "$LOG"

# ---------- compose 模式 ----------
run_compose() {
  cd "$WEB" 2>/dev/null || { echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"compose 目录 $WEB 不存在\"}" > "$RES"; rm -f "$REQ" "$RES.lock"; exit 1; }
  if docker compose pull >> "$LOG" 2>&1 && docker compose up -d >> "$LOG" 2>&1; then return 0; fi
  # 撞名冲突（旧容器是 docker run 建的，无 compose 标签）→ 删后用 compose 重建
  if grep -q "already in use" "$LOG" 2>/dev/null; then
    LBL=$(docker inspect "$NAME" -f '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
    if [ -z "$LBL" ]; then
      echo "检测到容器 $NAME 是 docker run 建的（脱离 compose 管理），已删除并用 compose 重建" >> "$LOG"
      docker rm -f "$NAME" >> "$LOG" 2>&1
      docker compose pull >> "$LOG" 2>&1
      docker compose up -d >> "$LOG" 2>&1 && return 0
    fi
  fi
  return 1
}

# ---------- docker run 模式（从 inspect 还原参数重建） ----------
run_run() {
  IMG=$(docker inspect "$NAME" -f '{{.Config.Image}}' 2>/dev/null)
  [ -n "$IMG" ] || { echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"取不到容器镜像名\"}" > "$RES"; rm -f "$REQ" "$RES.lock"; exit 1; }
  docker pull "$IMG" >> "$LOG" 2>&1 || { echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"docker pull $IMG 失败（网络？）\"}" > "$RES"; rm -f "$REQ" "$RES.lock"; exit 1; }

  ARGS=""
  # 数据卷
  for m in $(docker inspect "$NAME" -f '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.Mode}}{{"\n"}}{{end}}' 2>/dev/null); do
    [ -n "$m" ] || continue
    SRC=${m%%|*}; rest=${m#*|}; DST=${rest%%|*}; M=${rest#*|}
    RO=""; case "$M" in *ro*) RO=":ro";; esac
    ARGS="$ARGS -v $SRC:$DST$RO"
  done
  # 端口（HostIp 为 0.0.0.0 / :: 时省略，只写 主机端口:容器端口）
  for p in $(docker inspect "$NAME" -f '{{range $k,$v := .NetworkSettings.Ports}}{{range $v}}{{$k}}|{{.HostIp}}|{{.HostPort}}{{"\n"}}{{end}}{{end}}' 2>/dev/null); do
    [ -n "$p" ] || continue
    CPORT=${p%%|*}; r=${p#*|}; HIP=${r%%|*}; HPORT=${r#*|}
    [ -n "$HPORT" ] || continue
    case "$HIP" in 0.0.0.0|::|"") ARGS="$ARGS -p ${HPORT}:${CPORT}";; *) ARGS="$ARGS -p ${HIP}:${HPORT}:${CPORT}";; esac
  done
  # 环境变量 → 写临时文件用 --env-file，避免引号/空格踩坑
  ENVF=$(mktemp)
  docker inspect "$NAME" -f '{{range .Config.Env}}{{.}}{{"\n"}}{{end}}' 2>/dev/null > "$ENVF"
  [ -s "$ENVF" ] && ARGS="$ARGS --env-file $ENVF"
  # 重启策略
  RP=$(docker inspect "$NAME" -f '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)
  [ -n "$RP" ] && [ "$RP" != "no" ] && ARGS="$ARGS --restart $RP"
  # 网络
  NM=$(docker inspect "$NAME" -f '{{.HostConfig.NetworkMode}}' 2>/dev/null)
  [ -n "$NM" ] && [ "$NM" != "default" ] && ARGS="$ARGS --network $NM"
  # 用户
  U=$(docker inspect "$NAME" -f '{{.Config.User}}' 2>/dev/null)
  [ -n "$U" ] && ARGS="$ARGS --user $U"

  echo "重建参数：$ARGS" >> "$LOG"
  docker rm -f "$NAME" >> "$LOG" 2>&1
  if docker run -d --name "$NAME" $ARGS "$IMG" >> "$LOG" 2>&1; then
    rm -f "$ENVF"; return 0
  else
    rm -f "$ENVF"; return 1
  fi
}

if [ "$MODE" = "compose" ]; then run_compose; else run_run; fi
RC=$?

if [ "$RC" = "0" ]; then
  NEWV=$(docker exec "$NAME" cat /app/VERSION 2>/dev/null | tr -d ' \n')
  echo "{\"ok\":true,\"finishedAt\":\"$(date +%s)\",\"to\":\"$NEWV\",\"msg\":\"更新完成，当前 v$NEWV\"}" > "$RES"
  echo "==== $(date '+%F %T') 更新完成: v$NEWV（mode=$MODE）====" >> "$LOG"
  rm -f "$REQ" "$RES.lock"
else
  echo "{\"ok\":false,\"finishedAt\":\"$(date +%s)\",\"msg\":\"pull/重建失败，旧容器未受影响；详见宿主机 $LOG\"}" > "$RES"
  echo "==== $(date '+%F %T') 更新失败（容器未动）====" >> "$LOG"
  rm -f "$REQ" "$RES.lock"
  exit 1
fi
