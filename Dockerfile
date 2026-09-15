# syntax=docker/dockerfile:1

# ---------- 构建阶段：仅做语法检查（零依赖，无 npm install） ----------
FROM node:22-alpine AS check
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN node --check src/server.js \
 && for f in $(find src -name '*.js'); do node --check "$f" || exit 1; done

# ---------- 运行阶段 ----------
FROM node:22-alpine

LABEL org.opencontainers.image.title="TunePick" \
      org.opencontainers.image.description="NAS 音乐元数据刮削服务：直读本地音乐文件，三级刮削元数据并提供 REST API + Web 管理界面" \
      org.opencontainers.image.source="nas-music-scraper"

# 运行环境：生产、东八区；NODE_ENV=production 会关闭部分调试输出
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=8090 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    MUSIC_DIR=/music \
    SOURCE_KIND=localfs

WORKDIR /app

# 依赖清单（零第三方依赖，仅为元信息与 npm start 入口）
COPY package.json ./
# 应用源码
COPY --from=check /app/src ./src
# 运维脚本（check-all / probe-dir），便于容器内自检与目录探测
COPY --from=check /app/scripts ./scripts

# 数据与音乐目录：
#   /data  —— 自己的数据库（分片 JSON）与封面缓存，必须可写
#   /music —— 用户的音乐目录，**只读挂载**（PRD：原始音频文件严格只读）
RUN mkdir -p /data /music \
 && chown -R node:node /data /app

# 以非 root 运行
USER node

# 数据在容器外持久化
VOLUME ["/data"]

EXPOSE 8090

# 健康检查：/api/health 免鉴权（PRD §6.3）
# 注意：alpine 无 curl，用 node 内置 http 探测
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/server.js"]
