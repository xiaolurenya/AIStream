# AIStream — 影视聚合站点
# 零第三方依赖（只用 Node 内置模块），所以不需要 npm install，镜像很小
FROM node:22-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=8890
ENV HOST=0.0.0.0

WORKDIR /app
COPY server.js ./server.js
COPY VERSION ./VERSION
COPY public ./public

# 配置 / 用户 / 收藏 / 观看历史 / 图片缓存 全部落在这个卷里，重建容器不丢数据
VOLUME /data
EXPOSE 8890

CMD ["node", "server.js"]
