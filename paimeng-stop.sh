#!/bin/bash
# 派蒙 AI 应用工坊本地开发环境停止脚本
# 用途：停止所有正在运行的服务（Java 后端、TS Agent、Vue 前端、Docker 基础设施）
# 使用：./stop.sh [--keep-infra]

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
KEEP_INFRA=false

# 解析参数
for arg in "$@"; do
  case $arg in
    --keep-infra)
      KEEP_INFRA=true
      ;;
    *)
      echo "未知参数: $arg"
      echo "用法: $0 [--keep-infra]"
      exit 1
      ;;
  esac
done

echo "========================================="
echo "派蒙 AI 应用工坊本地环境停止"
echo "========================================="
echo ""

# 停止前端（端口 5173）
echo "[1/4] 停止 Vue 前端..."
if lsof -iTCP:5173 -sTCP:LISTEN -t > /dev/null 2>&1; then
  lsof -iTCP:5173 -sTCP:LISTEN -t | xargs kill 2>/dev/null || true
  echo "  前端已停止"
else
  echo "  前端未运行"
fi
echo ""

# 停止 TS Agent（端口 8092）
echo "[2/4] 停止 TS Agent..."
if lsof -iTCP:8092 -sTCP:LISTEN -t > /dev/null 2>&1; then
  lsof -iTCP:8092 -sTCP:LISTEN -t | xargs kill 2>/dev/null || true
  echo "  Agent 已停止"
else
  echo "  Agent 未运行"
fi
echo ""

# 停止 Java 后端（端口 8123）
echo "[3/4] 停止 Java 后端..."
if lsof -iTCP:8123 -sTCP:LISTEN -t > /dev/null 2>&1; then
  lsof -iTCP:8123 -sTCP:LISTEN -t | xargs kill 2>/dev/null || true
  sleep 2
  # 如果还没停止，强制终止
  if lsof -iTCP:8123 -sTCP:LISTEN -t > /dev/null 2>&1; then
    lsof -iTCP:8123 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
    echo "  后端已强制停止"
  else
    echo "  后端已停止"
  fi
else
  echo "  后端未运行"
fi
echo ""

# 停止 Docker 基础设施
if [ "$KEEP_INFRA" = false ]; then
  echo "[4/4] 停止 Docker 基础设施..."
  cd "$PROJECT_ROOT"
  if docker compose ps --quiet | grep -q .; then
    docker compose stop
    echo "  基础设施已停止"
    echo ""
    echo "提示: 如需完全清理，执行 'docker compose down'"
  else
    echo "  基础设施未运行"
  fi
else
  echo "[4/4] 保留 Docker 基础设施运行"
fi
echo ""

echo "========================================="
echo "停止完成"
echo "========================================="
