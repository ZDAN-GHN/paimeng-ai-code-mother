#!/usr/bin/env bash
# 把 node_modules 归位到 wsl-rt-env 约定位置：
# 物理目录永远在 wsl-rt-env/ts-agent/node_modules，服务目录内只放符号链接。
# npm install / npm ci 会把符号链接替换回实体目录（arborist reify 行为），
# 因此每次依赖安装后执行本脚本归位；npm run dev / npm test 不重排依赖树，无需执行。
set -euo pipefail
cd "$(dirname "$0")/.."

REAL="../wsl-rt-env/ts-agent/node_modules"

if [ -L node_modules ]; then
  echo "node_modules 已是符号链接 -> $(readlink node_modules)，无需归位"
  exit 0
fi

mkdir -p "$(dirname "$REAL")"
if [ -d node_modules ]; then
  # npm 刚重装的实体目录是最新事实，覆盖 wsl-rt-env 侧旧副本
  rm -rf "$REAL"
  mv node_modules "$REAL"
fi

ln -s "$REAL" node_modules
echo "node_modules 已归位 -> $(readlink node_modules)"
