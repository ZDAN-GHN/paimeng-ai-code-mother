#!/usr/bin/env bash
# 构建生产运行时镜像（Issue #81 / T-09）
#
#   infra/docker/deployment/build.sh <source-dir> [image-ref]
#
# <source-dir> 是一个已冻结的候选快照或固定模板目录。**不要**把仓库根目录或
# assets/application-template 直接作为构建上下文：模板的 .dockerignore 是 #79
# 验证镜像的安全边界（白名单式，只放行验证所需文件），为部署镜像放宽它会让构建
# 上下文里多出与运行无关的文件，也让两处边界各自漂移。
#
# 这里的做法是：按白名单复制出干净上下文，再对干净上下文构建。白名单与模板
# .dockerignore 保持一致，只额外放行运行时构建必需的源码与 tsconfig。
set -euo pipefail

SOURCE_DIR="${1:-}"
IMAGE_REF="${2:-paimeng-application-runtime:0.1.0}"
DOCKERFILE_REL="infra/docker/deployment/Dockerfile"

if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
  echo "用法: $0 <source-dir> [image-ref]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DOCKERFILE="$REPO_ROOT/$DOCKERFILE_REL"
[[ -f "$DOCKERFILE" ]] || { echo "找不到 Dockerfile: $DOCKERFILE" >&2; exit 2; }

# 运行时构建所需的白名单。package-lock.json 必须一起带上，否则 npm ci 无法复现依赖。
ALLOWLIST=(
  package.json
  package-lock.json
  prisma.config.ts
  prisma
  src
  tsconfig.server.json
  vite.config.ts
)

CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT

for entry in "${ALLOWLIST[@]}"; do
  if [[ -e "$SOURCE_DIR/$entry" ]]; then
    cp -R "$SOURCE_DIR/$entry" "$CONTEXT/"
  else
    echo "构建上下文缺少必需文件: $entry" >&2
    exit 2
  fi
done

# 上下文已经过上面的白名单复制，这里无需再限制；node_modules 也不会被复制进来。
printf '' > "$CONTEXT/.dockerignore"

echo "构建上下文已准备: $SOURCE_DIR -> $(basename "$CONTEXT")"
echo "构建镜像: $IMAGE_REF"
exec docker build --pull=false -f "$DOCKERFILE" -t "$IMAGE_REF" "$CONTEXT"