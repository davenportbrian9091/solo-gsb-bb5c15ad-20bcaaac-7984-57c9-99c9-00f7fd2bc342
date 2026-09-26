# ---------- 构建阶段 ----------
# 完整镜像自带 python3 / make / g++，better-sqlite3 下载不到预编译包时可回退源码编译
FROM node:20-bookworm AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- 运行阶段 ----------
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json server.js db.js replay.js assignment.js rotation.js absence.js routing.js ./
COPY public ./public

# SQLite 数据文件目录（首次启动自动建表并写入示例数据），可挂载卷持久化
ENV DATA_DIR=/app/data
EXPOSE 3000

CMD ["node", "server.js"]
