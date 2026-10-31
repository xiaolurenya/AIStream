# AIStream —— 影视聚合站点（分发仓库）
#
# 本仓库仅用于分发与部署说明。核心运行镜像为预构建的：
#   xiaoluya/aistream:latest
# 用户直接 `docker compose up -d` 即可拉取运行，无需从源码构建。
# 源码与构建流程不在此公开仓库内。

FROM xiaoluya/aistream:latest
