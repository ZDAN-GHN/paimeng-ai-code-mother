# 版本化二阶段：普通 git 仓库 + AI 直接操作 git

> **Archived 2026-10-29.** Superseded by [version-git-source.md](./version-git-source.md); the unchecked acceptance items below were not completed as written. This file is historical only.

用户决策（2026-10-21）：废弃「git 裸库 + 自定义版本工具」，改为**工作区内真实 git 仓库 + bash 工具 + AI 直接执行 git 命令**。理由写进历史教训：空版本、假指针、假合并、采纳变回退，每一个都源自我们用 plumbing 手工重演 git 已解决的问题，然后演错。模型的母语就是 git（天天在真实仓库里干活），`restoreVersion`/`adoptBranch` 对它反而是外语。

本阶段在 `feat/app-versioning`（裸库一阶段，已提交 `f9bd4bb`）之上开发，分支 `feat/version-git-native`。

## 1. 目标形态

```
runtime/code_output/<type>_<id>/      工作区，自带 .git（普通仓库）
  .git/
    hooks/reference-transaction       平台安全闸（见 §3）
    ……
```

- AI 通过 **bash 工具** 在工作区内直接跑 `git add/commit/branch/merge/restore/…`：语义由 git 保证，不再有自写合并逻辑
- 一阶段的 `restoreVersion`/`branchFromVersion`/`adoptBranch`/`switchBranch`/`listVersions`/`getVersion` 六个模型工具**退役**（面板按钮保留，内部改走 git 语义）
- 版本表降级为**元数据缓存**：按 commit sha 记录标题、缩略图、AI 概述、触达来源（bash/生成收尾/面板）；git 才是事实源，表丢了可重建（backfill 脚本已有雏形）

## 2. 并行分工（三个单元，接口先冻结）

| 单元 | 内容 | 独占写入范围 | 依赖 |
| --- | --- | --- | --- |
| **U1 契约与仓库引擎**（主代理） | 本文档、`version-store.ts` 重写为「ensureRepo（普通仓库 + 迁移裸库数据）+ syncFromGit（fsck 源）」、迁移脚本、锁沿用 | `src/server/version-store.ts`、`scripts/`、`migrations/005` | 无 |
| **U2 bash 工具与 hook**（worker，隔离工作树） | `harness-server.ts`：bash 工具（cwd=工作区、白名单、输出截断）、reference-transaction hook 安装、版本工具退役 | `src/server/durable/harness-server.ts`、`src/server/durable/protocol.ts`（→9）、`scripts/lib/git-hooks.ts` | U1 的 hook 文件路径契约 |
| **U3 面板与转录同步**（worker，隔离工作树） | 面板改读 git（log/branch），版本行仍读表（标题/缩略图）；`durable-engine.ts` 收尾从「commitVersion」改为「检测 AI 已提交则只记元数据」 | `src/components/chat/version-panel.tsx`、`version-graph.tsx`、`src/server/durable-engine.ts`、`src/server/business.ts` 读路径 | U1 的 `syncFromGit` 契约 |

冻结的接口（先写进 `src/shared/versioning.ts`，U2/U3 只依赖它）：

```ts
// 事实源切换：git 是历史事实源，表是展示元数据
listVersions(app)         // 内部：git log + 表 join（标题/缩略图可缺省）
syncFromGit(app)          // git refs → app_version 行（幂等；同树空提交仍跳过；kind 按提交来源推断）
ensureRepo(app)           // 普通仓库；发现裸库则一次性迁移（refs/objects 复制 + checkout）
installGitGuard(repo)     // 写 reference-transaction hook（U2 的 bash 依赖它存在）
```

## 3. 安全闸：不是包装函数，是 git 自己的机制

1. **`reference-transaction` hook**（`prepare`/`committed` 两阶段）：
   - 禁止删除 refs、禁止对 `refs/heads/*` 的非快进更新（`old != null && new == null` 或 `new` 不是 `old` 后代 → exit 1）
   - 「历史只增」由 git 强制执行；模型想 reset --hard 也不动 refs，重提交即可（工作区脏内容本来就会在下次收尾快照）
2. **bash 工具命令白名单**：git 子命令放行（add/commit/branch/checkout/merge/restore/log/diff/status/show/stash…），拒绝 `push/pull/fetch/gc/filter-branch/reflog/delete-branch -D/rebase` 等改写或外联命令；非 git 命令按现有 blocked 目录语义（不碰 `.git` 之外的越权路径已由 cwd 保证）——白名单在工具执行体里做字符串前缀判定，拦截原因中文返回给模型
3. `.git` 仍留在 `workspace.ts` blocked 集合：文件工具（read/write/edit/listFiles）碰不到版本库，只有 bash 能
4. Docker 构建上下文加 `.dockerignore`（忽略 `.git`），构建不背上历史

## 4. 面板与收尾的新语义

- 收尾（`durable-engine.recordGenerationVersion`）：工作区有未提交改动 → `git add -A（带排除）+ commit`（AI 忘了提交也兜底）；然后 `syncFromGit` 补元数据行
- AI 在 bash 里自己 commit → 收尾发现干净，只补元数据（标题走 AI 概述，来源标 `bash`）
- 面板「回到此版本」按钮 → 服务端执行受控 `git restore --source=<sha>` + 提交（仍是 UI 主路径，用户不该被逼着跟模型说话）；「从此版开分支」「采纳」同理走 git 语义（祖先无操作/快进/merge-tree）
- 树状图数据（`versionGraph`）改从 git 拓扑直接算（`rev-list --parents` + refs），表只提供标题/缩略图

## 5. 迁移（一次性，脚本 `scripts/migrate-bare-to-worktree.ts`）

对每个已有应用：`git clone --bare versionstore/<app>.git` → 工作区内 `git init` + `fetch` 裸库 + `checkout main`；表数据不动（sha 不变，join 仍成立）；成功后归档裸库目录（`versionstore/<app>.git.migrated`），不删除。

## 6. 验收线

- [ ] 单元：hook 拦截——非快进更新被拒（exit 1 且 refs 不变）、删 refs 被拒、正常 commit/branch/merge 放行
- [ ] 单元：白名单——`git push`/`git gc`/`git filter-branch` 被拒并返回中文原因；`git commit -m` 放行
- [ ] 集成：迁移——裸库数据迁到工作区仓库后 `git log` 一致、版本表 join 不变、旧缩略图仍显示
- [ ] 集成：AI 链路——模型用 bash 提交后收尾不重复提交、元数据行生成；模型忘了提交收尾兜底
- [ ] 集成：采纳三语义回归在新实现下保持（祖先无操作/快进/三方合并）
- [ ] E2E：面板树/回退/开分支在普通仓库后端下全过（复用 `version-panel.spec.ts`，mock 改造）
- [ ] `type-check`、`check:fast`、单元与集成全绿；真实应用迁移后肉眼验收

## 7. 明确不做

- 不做模型侧 push/fetch（没有远端概念）
- 不做 reflog 依赖（hook 已禁改写）
- 裸库一阶段的代码保留在 `feat/app-versioning` 分支历史里，不回移植
