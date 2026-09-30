# 生产运行时镜像（Issue #81 / T-09）
#
# Build with:
#   docker build --pull=false -f infra/docker/deployment/Dockerfile \
#     -t paimeng-application-runtime:0.1.0 assets/application-template
#
# 与 infra/docker/validation/Dockerfile 的分工：那个镜像跑四门验证（需要 prisma CLI、
# node --test 与验证脚本），这个镜像只负责**运行已构建产物**，不含任何验证脚本与测试。
#
# 依赖基底必须与 #79 的固定依赖验证镜像一致（node 24.20.0 + libssl3）：模板按该版本锁定并
# 做过真实 Prisma Migration Gate，换基底等于让「验证通过的代码」跑在「没验证过的运行时」上。
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# Prisma migration CLI 加载 OpenSSL 3. Fail the build if the security package is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libssl3=3.0.22-1~deb12u1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app

# 依赖与 Prisma Client 先于源码安装：只改代码时这一层可直接命中缓存。
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund \
    && ./node_modules/.bin/prisma generate \
    && chmod -R a+rX /opt/app

COPY tsconfig.server.json vite.config.ts ./
COPY src ./src
# 不跑 `npm run build`：它先执行 type-check，而 type-check 需要 tsconfig.test.json、
# tsconfig.web.json 与 test/ 目录，把测试代码一起带进生产镜像。全量类型检查已由 #79 的
# Engineering Gate 在候选快照上执行过（验证门禁是权威判定），生产构建只负责生成产物。
RUN ./node_modules/.bin/tsc -p tsconfig.server.json \
    && ./node_modules/.bin/vite build \
    && test -f dist/server/server.js \
    && test -d dist/public

# 模板默认 HOST=127.0.0.1，容器内必须覆盖为 0.0.0.0，否则应用只监听容器内回环，
# 跨容器网络的健康探测与公开转发都会连不上（AD-016：Deployment 不发布宿主机端口，
# 可达性只能靠内部 Deployment network）。
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8123 \
    HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    XDG_CACHE_HOME=/tmp/.cache

# 容器内监听端口。仅用于容器内监听与内部网络寻址，镜像不发布任何宿主机端口。
EXPOSE 8123

# 不写入任何凭据：DATABASE_URL 与 APP_BASE_PATH 由 Platform 在启动时注入。
# 镜像里出现明文口令等于把它分发到每一台装了镜像的机器上。
USER node

CMD ["node", "dist/server/server.js"]