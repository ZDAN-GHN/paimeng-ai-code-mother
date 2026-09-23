#!/bin/bash
# 派蒙 AI 应用工坊本地开发环境启动脚本
# 用途：依次启动 Docker 基础设施、Java 后端、TS Agent（占位）、Vue 前端
# 使用：./start.sh [--skip-infra] [--skip-backend] [--skip-agent] [--skip-frontend]

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/paimeng-ai-code-backend"
AGENT_DIR="$PROJECT_ROOT/paimeng-ai-code-agent"
FRONTEND_DIR="$PROJECT_ROOT/paimeng-ai-code-frontend"
LOG_DIR="/tmp/opencode"

SKIP_INFRA=false
SKIP_BACKEND=false
SKIP_AGENT=false
SKIP_FRONTEND=false

# 解析参数
for arg in "$@"; do
  case $arg in
    --skip-infra) SKIP_INFRA=true ;;
    --skip-backend) SKIP_BACKEND=true ;;
    --skip-agent) SKIP_AGENT=true ;;
    --skip-frontend) SKIP_FRONTEND=true ;;
    *)
      echo "未知参数: $arg"
      echo "用法: $0 [--skip-infra] [--skip-backend] [--skip-agent] [--skip-frontend]"
      exit 1
      ;;
  esac
done

mkdir -p "$LOG_DIR"

echo "========================================="
echo "派蒙 AI 应用工坊本地环境启动"
echo "========================================="
echo ""

# 1. 启动 Docker 基础设施
if [ "$SKIP_INFRA" = false ]; then
  echo "[1/4] 启动 Docker 基础设施（MySQL + PostgreSQL + Redis + SearXNG + Nginx）..."
  if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "错误: 缺少 .env 文件。请复制 .env.example 为 .env 并设置必需环境变量。"
    exit 1
  fi
  
  cd "$PROJECT_ROOT"
  docker compose up -d
  
  echo "等待基础设施健康检查..."
  for service in mysql postgres redis searxng nginx; do
    echo -n "  等待 $service... "
    timeout=60
    while [ $timeout -gt 0 ]; do
      if docker compose ps --format json | jq -e ".[] | select(.Service == \"$service\" and (.Health == \"healthy\" or .Health == \"\"))" > /dev/null 2>&1; then
        echo "就绪"
        break
      fi
      sleep 1
      timeout=$((timeout - 1))
    done
    if [ $timeout -eq 0 ]; then
      echo "超时"
      echo "警告: $service 未就绪，服务可能无法正常工作"
    fi
  done
  echo ""
else
  echo "[1/4] 跳过 Docker 基础设施启动"
  echo ""
fi

# 2. 启动 Java 后端
if [ "$SKIP_BACKEND" = false ]; then
  echo "[2/4] 启动 Java 后端（端口 8123）..."
  
  # 检查端口占用
  if lsof -iTCP:8123 -sTCP:LISTEN -t > /dev/null 2>&1; then
    echo "警告: 端口 8123 已被占用，尝试停止旧进程..."
    lsof -iTCP:8123 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
    sleep 2
  fi
  
  cd "$BACKEND_DIR"
  nohup ./mvnw spring-boot:run > "$LOG_DIR/paimeng-backend.log" 2>&1 &
  BACKEND_PID=$!
  echo "  Java 后端已启动，PID: $BACKEND_PID"
  echo "  日志: $LOG_DIR/paimeng-backend.log"
  
  # 等待后端就绪
  echo -n "  等待后端健康检查... "
  timeout=60
  while [ $timeout -gt 0 ]; do
    if curl -sf http://127.0.0.1:8123/api/health/ > /dev/null 2>&1; then
      echo "就绪"
      break
    fi
    sleep 1
    timeout=$((timeout - 1))
  done
  if [ $timeout -eq 0 ]; then
    echo "超时"
    echo "警告: 后端未就绪，请检查日志 $LOG_DIR/paimeng-backend.log"
  fi
  echo ""
else
  echo "[2/4] 跳过 Java 后端启动"
  echo ""
fi

# 3. 启动 TS Agent（当前为占位）
if [ "$SKIP_AGENT" = false ]; then
  echo "[3/4] 启动 TS Agent（端口 8092）..."
  
  if [ ! -d "$AGENT_DIR/node_modules" ]; then
    echo "  TS Agent 依赖未安装，跳过启动"
    echo "  提示: cd $AGENT_DIR && npm ci"
  else
    # 检查端口占用
    if lsof -iTCP:8092 -sTCP:LISTEN -t > /dev/null 2>&1; then
      echo "警告: 端口 8092 已被占用，尝试停止旧进程..."
      lsof -iTCP:8092 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
      sleep 2
    fi
    
    cd "$AGENT_DIR"
    nohup npm start > "$LOG_DIR/paimeng-agent.log" 2>&1 &
    AGENT_PID=$!
    echo "  TS Agent 已启动，PID: $AGENT_PID"
    echo "  日志: $LOG_DIR/paimeng-agent.log"
    
    # 等待 Agent 就绪
    echo -n "  等待 Agent 健康检查... "
    timeout=30
    while [ $timeout -gt 0 ]; do
      if curl -sf http://127.0.0.1:8092/healthz > /dev/null 2>&1; then
        echo "就绪"
        break
      fi
      sleep 1
      timeout=$((timeout - 1))
    done
    if [ $timeout -eq 0 ]; then
      echo "超时"
      echo "警告: Agent 未就绪，请检查日志 $LOG_DIR/paimeng-agent.log"
    fi
  fi
  echo ""
else
  echo "[3/4] 跳过 TS Agent 启动"
  echo ""
fi

# 4. 启动 Vue 前端
if [ "$SKIP_FRONTEND" = false ]; then
  echo "[4/4] 启动 Vue 前端（端口 5173）..."
  
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "错误: 前端依赖未安装。请先执行："
    echo "  cd $FRONTEND_DIR && npm install"
    exit 1
  fi
  
  # 检查端口占用
  if lsof -iTCP:5173 -sTCP:LISTEN -t > /dev/null 2>&1; then
    echo "警告: 端口 5173 已被占用，尝试停止旧进程..."
    lsof -iTCP:5173 -sTCP:LISTEN -t | xargs kill -9 2>/dev/null || true
    sleep 2
  fi
  
  cd "$FRONTEND_DIR"
  nohup npm run dev -- --host 127.0.0.1 > "$LOG_DIR/paimeng-frontend.log" 2>&1 &
  FRONTEND_PID=$!
  echo "  Vue 前端已启动，PID: $FRONTEND_PID"
  echo "  日志: $LOG_DIR/paimeng-frontend.log"
  
  # 等待前端就绪
  echo -n "  等待前端就绪... "
  timeout=30
  while [ $timeout -gt 0 ]; do
    if curl -sf http://127.0.0.1:5173 > /dev/null 2>&1; then
      echo "就绪"
      break
    fi
    sleep 1
    timeout=$((timeout - 1))
  done
  if [ $timeout -eq 0 ]; then
    echo "超时"
    echo "警告: 前端未就绪，请检查日志 $LOG_DIR/paimeng-frontend.log"
  fi
  echo ""
else
  echo "[4/4] 跳过 Vue 前端启动"
  echo ""
fi

echo "========================================="
echo "启动完成"
echo "========================================="
echo ""
echo "访问地址:"
echo "  前端:   http://127.0.0.1:5173"
echo "  后端:   http://127.0.0.1:8123/api"
echo "  Agent:  http://127.0.0.1:8092"
echo ""
echo "日志目录: $LOG_DIR"
echo ""
echo "停止服务:"
echo "  ./stop.sh"
echo ""
