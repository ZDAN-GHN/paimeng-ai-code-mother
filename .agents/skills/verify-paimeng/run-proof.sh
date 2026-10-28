#!/usr/bin/env bash
# 用法: run-proof.sh <spec 路径> [--dev]
# 用仓库的隔离启动器跑一个 spec，把日志和 Playwright 报告归档到 runtime/evidence/runs/。
set -uo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
app="$repo/paimeng-ai-code-agent"
cd "$app" || { echo "找不到应用目录: $app" >&2; exit 2; }

spec="${1:-}"
mode="${2:-}"
if [ -z "$spec" ]; then
  echo "用法: run-proof.sh <spec 路径> [--dev]" >&2
  exit 2
fi
if [ ! -f "$spec" ]; then
  echo "找不到 spec: $spec" >&2
  exit 2
fi

slug="$(basename "$spec" .spec.ts)"
stamp="$(date +%Y%m%d-%H%M%S)"
archive="runtime/evidence/runs/${slug}-${stamp}"
mkdir -p "$archive"

export E2E_APP_PORT="${E2E_APP_PORT:-3020}"
export E2E_PREVIEW_PORT="${E2E_PREVIEW_PORT:-3021}"
if [ "$mode" = "--dev" ]; then
  export E2E_APP_MODE=dev
fi

echo "证明: $spec"
echo "端口: 应用 $E2E_APP_PORT / 预览 $E2E_PREVIEW_PORT（harness 自选空闲端口）"
echo "归档: $archive"

npm run test:e2e:isolated -- "$spec" 2>&1 | tee "$archive/run.log"
status="${PIPESTATUS[0]}"

for dir in test-results playwright-report; do
  if [ -d "$dir" ]; then cp -a "$dir" "$archive/" 2>/dev/null || true; fi
done

if [ "$status" -eq 0 ]; then
  echo "通过。日志与报告: $archive"
else
  echo "失败（退出码 $status）。日志与报告: $archive" >&2
fi
exit "$status"
