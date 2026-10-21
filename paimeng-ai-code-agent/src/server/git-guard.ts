import 'server-only';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 安装 reference-transaction hook：历史只增的强制闸。
 * - 禁止删除 refs/heads/*
 * - 禁止对 refs/heads/* 的非快进更新（改写历史）
 * 提交、开分支、快进合并、--no-ff 合并全部放行。
 * 用 bash 而不是 sh：`<<<`/`[[` 不在 POSIX sh 里。
 */
export async function installGitGuard(repoWorkTree: string) {
  const hooksDir = join(repoWorkTree, '.git', 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const file = join(hooksDir, 'reference-transaction');
  const script = `#!/bin/bash
# 由 paimeng 平台安装：应用历史只增，删除分支与非快进更新一律拒绝。
zero=0000000000000000000000000000000000000000
while read -r old new ref; do
  [ -z "$ref" ] && continue
  case "$ref" in refs/heads/*) ;; *) continue ;; esac
  if [ "$new" = "$zero" ] || [ -z "$new" ]; then
    echo "禁止删除分支 $ref（应用历史只增，删除请走删除应用）" >&2
    exit 1
  fi
  if [ -n "$old" ] && [ "$old" != "$zero" ]; then
    if ! git merge-base --is-ancestor "$old" "$new" 2>/dev/null; then
      echo "禁止非快进更新 $ref（应用历史只增，不能改写；要回到旧版本请提交新内容而不是移动分支指针）" >&2
      exit 1
    fi
  fi
done
exit 0
`;
  await writeFile(file, script, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}
