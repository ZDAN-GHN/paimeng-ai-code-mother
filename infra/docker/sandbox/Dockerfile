# 受控 Run 执行的 Sandbox 模板镜像（Issue #77 / T-05）。
#
# 构建：
#   docker build -t paimeng-ai-code-sandbox:0.1.0 infra/docker/sandbox
#
# 这个镜像只承载「Agent 工具调用的执行环境」，不承载生成应用的构建与校验：
# Vue 产物的 npm install / npm run build 走既有宿主机路径
# （paimeng-ai-code-backend/src/main/java/.../core/builder/NpmBuilder.java），
# Validation 与 Production Deployment 是 T-05 的明确非目标。
#
# 容器由 PlatformSandboxExecutor 以下述约束创建（AD-016 / AC-4）：
#   --network none        无任何网络命名空间，外连必然失败
#   --init                tini 作 PID 1，转发 SIGTERM，使 10 秒优雅停止真实生效
#                         （PID 1 不响应默认处置的信号，没有 init 则只能等 SIGKILL）
#   --read-only           根文件系统只读，仅 /workspace 与 /tmp 可写
#   不挂载 Docker Socket、不挂载宿主机敏感路径，只挂载该 Run 的 workspace
#
# 基线镜像按可复现要求钉到 digest，不依赖浮动 tag。
# node:24.20.0-bookworm-slim（24.20.0-slim 是同一 digest 的别名），与 TS Agent
# 锁定的 Node 24.20.0 对齐。
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

LABEL org.opencontainers.image.title="paimeng-ai-code-sandbox" \
      org.opencontainers.image.description="Controlled Run execution sandbox for T-05" \
      org.opencontainers.image.source="https://github.com/ZDanHub/paimeng-ai-code-mother"

# 根文件系统只读时，node 与 npm 默认写 $HOME 下的缓存目录会直接失败。
# 把缓存统一指向 /tmp（执行器以 tmpfs 挂载），消掉这个失败模式。
ENV npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    XDG_CACHE_HOME=/tmp/.cache

# 官方 node 镜像已自带非 root 用户 node（uid/gid 1000），不另建用户。
# workspace 是 Run 的唯一可写数据面，挂载点所有权须归该用户。
RUN mkdir -p /workspace && chown node:node /workspace

WORKDIR /workspace
USER node

# 容器需常驻等待 exec 注入命令；真正的命令由 execCreateCmd 下发。
# 配合 --init，SIGTERM 由 tini 转发到 sleep，容器按默认处置退出。
CMD ["sleep", "infinity"]
