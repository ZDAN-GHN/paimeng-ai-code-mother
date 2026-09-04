#!/usr/bin/env bash
# 依赖归位脚本（WSL）：安装依赖并物理放到 wsl-rt-env 约定位置。
# 流程：npm install 在服务目录正常安装（package-lock.json 同步更新、锁定版本事实），
# 然后把实体目录移动到 ../wsl-rt-env/ts-agent/node_modules —— 服务目录内不放 node_modules、也不建符号链接。
# 运行/测试/类型检查命令统一经 scripts/run.mjs / vitest.config.mjs / tsconfig.json 指向该位置。
# 每次执行都会重新安装并归位（npm install 对已满足的依赖是增量操作，代价很小）。
set -euo pipefail
cd "$(dirname "$0")/.."

REAL="../wsl-rt-env/ts-agent/node_modules"

if [ -L node_modules ]; then
  echo "检测到旧符号链接 node_modules，先移除（新约定不再使用软链）" >&2
  rm node_modules
fi

npm install

# npm 刚装的实体目录是最新事实，覆盖 wsl-rt-env 侧旧副本
rm -rf "$REAL"
mkdir -p "$(dirname "$REAL")"
mv node_modules "$REAL"

echo "node_modules 已归位 -> $REAL（服务目录内不再保留任何 node_modules）"
