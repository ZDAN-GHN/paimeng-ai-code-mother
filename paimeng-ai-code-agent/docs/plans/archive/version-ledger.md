# 版本台账：一张表 + 只读 git + 线性清单

> **Archived 2026-10-29.** Historical implementation record. Current version behavior is described by the [implementation contract](../../implementation-contract.md); this file preserves the ledger design and verification as written.

取代 version-git-source.md 中「分支/合并/树」的产品语义。存储层（git 仓库、原子回退、钉子引用）全部沿用，产品层收敛为：**成功才出版本，版本记在一张表里，清单线性，agent 的 git 只读**。

> 评审已通过（2026-10-22）。五处修订已并入正文：表名与迁移编号、外键类型、租约内落账的挂点、标题与 current 的收口、自愈的层级归属。

## 用户可见结果与不变量

- 一次生成走到 `ready` 恰好记一个版本：一行 `version_record`，一个 git 提交，一个 `refs/paimeng/versions/<sha>` 钉子。标题写 agent 的本轮总结。
- 失败、取消、纯问答（零源码改动）不出版本。
- 版本面板是一张按时间排的线性清单：截图、总结、时间、当前标记（= 工作区 HEAD）。每行一个动作：使用这一版本（正在使用的那版禁用）。
- 回退仍是检出旧提交（detached），改动守卫与真实构建照旧；回退后再生成成功，新版本接在回退点上，清单按时间仍线性。
- agent 的 git 工具只读。它读到的 `git log` 是干净的一轮一提交的项目叙事，`git diff` 是本轮未提交的改动。
- 表只放清单与产品字段，不放 git 的事实（拓扑、heads、文件清单）；git 只当内容库。两个源头各管一个事实，永不对账。

## 冻结契约

表名是 `version_record`，不是 `app_version`：后者已被 `004_versioning.sql` 占用，且该表按要求永久保留为迁移的只读数据源。迁移文件因此排在它之后，为 `005_version_ledger.sql`。

```sql
CREATE TABLE version_record (
  commit_sha    CHAR(40) NOT NULL,              -- 对外 versionId，API 参数不变
  app_id        BIGINT   NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  generation_id VARCHAR(36) REFERENCES generation(id) ON DELETE SET NULL,
  title         TEXT     NOT NULL,              -- agent 总结，写入时截断 200 字符
  create_time   TIMESTAMP(3) NOT NULL,          -- 与其它表一致：UTC 朴素时间戳
  -- 提交只在各自仓库里唯一：两个应用可能在同一秒提交出完全相同的 SHA。
  PRIMARY KEY (app_id, commit_sha)
);
CREATE INDEX idx_version_record_app_time ON version_record (app_id, create_time DESC);
CREATE UNIQUE INDEX idx_version_record_generation ON version_record (generation_id)
  WHERE generation_id IS NOT NULL;
```

`generation.id` 的真实类型是 `varchar(36)`（schema.ts:8），外键按此对齐。`generation_id` 的部分唯一索引保证收尾重放天然幂等。表行随应用删除级联；git 仓库由 `purgeVersions` 单独回收，两条路径并存、互不重复。

共享类型 `src/shared/versioning.ts`：

- `AppVersion = { id(=sha), title, createTime, changedFiles?, fileCount?, bytes?, thumbnailKey? }`。删除 `parents / heads / merged / kind / VersionPosition / VersionGraph` 等树形字段；文件统计仍按需从 git 算，不入表。
- `AppVersionOverview = { versions: AppVersion[], current: { versionId: string } | null }`。`current` 只保留「工作区 HEAD 是哪一版」这一条事实，不再携带分支/拓扑。

模块边界：

- `src/server/version-ledger.ts`（新增，唯一写表者，零 git 依赖）：`insertVersionRow`（ON CONFLICT DO NOTHING）、`listVersionRows(appId,{query?,limit?})`、`versionRowOf(sha)`。
- `src/server/version-store.ts`（保持零 PG）：`commitVersion`（提交 + 钉子 + main 可快进则快进）、`restoreVersion`、`diffVersions`、`listVersionPins`（只读枚举钉子）、缩略图。删除 `versionGraph / branchFromVersion / adoptBranch / switchBranch / ensureVersionBranch`。
- `src/server/version-heal.ts`（新增，协调层，唯一同时依赖 git 与表的地方）：`healVersionRows(app)` 读钉子、读 commit message、调 `insertVersionRow` 补行。由版本列表入口调用。
- API：list / get / restore / diff / thumbnail 保留；branch / adopt / switch 端点删除。

## 单元与顺序（串行，每单元独立可验）

| # | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| U1 | 建表 + 台账模块 + 自愈 | `005_version_ledger.sql`、`version-ledger.ts`、`version-heal.ts`、`schema.ts` | 台账集成用例绿：插入、幂等、级联、补行 |
| U2 | version-store 减法 | `version-store.ts`、`shared/versioning.ts` | 既有回退/提交/钉子用例全绿；分支类用例随删 |
| U3 | 收尾 hook 接线 | `generation-store.ts`、`durable-engine.ts`、`version-summary.ts` | 一轮一版、租约内落账、失败零版本 |
| U4 | agent git 只读化 | `git-args.ts`、`harness-server.ts`、`generation-instructions.ts`、`protocol.ts` 10→11 | git-tool 用例改为「读可用、写拒绝」 |
| U5 | API 与面板线性化 | `business.ts`、api 路由、`version-panel.tsx`（删 `version-graph.tsx`） | version-panel e2e 重写后绿 |
| U6 | 回填与清理 | `scripts/versions-backfill.ts`、docs | dry-run 预演真实库；旧面板术语清零 |

## 各单元详设

### U3 收尾 hook

落账必须发生在**租约仍被持有**的时刻，且只在任务真的要变成 `ready` 时才发生。租约释放在 `finishGeneration` 的数据库事务内部（`generation-store.ts:196`），`canFinish` 回调在此之前（`:189`）决定这一轮算不算完成。因此给 `finishGeneration` 加一个 `beforeRelease` 钩子，在 `canFinish` 通过之后、删租约之前执行：

```text
finishGeneration(requestId, 'ready', …, canFinish, beforeRelease)
  transaction:
    canFinish() 通过
    beforeRelease():
      已有该 generation 的行？有则跳过（幂等）
      源码真实改动为空？空则不出版本
      title = agent 本轮总结（末条助手消息文本）
              空话（「好的」「已完成」）或超长 → 截断，退回 fallbackVersionTitle
      commitVersion({app, title})          → 提交 + 钉 refs/paimeng/versions/<sha>
      insertVersionRow({sha, app, generation, title})
    删租约
```

标题在插行时即终稿，收尾不再有异步改写链路。现状的 `commitVersion` 先写固定兜底标题、收尾再异步 `setVersionTitle` 覆盖（`durable-engine.ts:697` 与 `:708`）这条两段式链路从收尾删除；`summarizeVersion` / `setVersionTitle` 只留作历史版本的回填工具（U6 与 `versions:titles` 脚本），不再参与新版本落账。

agent 只读化之后，「模型自己提交时以 HEAD 为版本」的兜底分支（`durable-engine.ts:698` 的 `listVersions(...).current`）整体消失，版本永远来自本 hook 的那次提交。

失败轮次没有 `beforeRelease`：`canFinish` 拒绝时任务回到修复循环，不提交、不插行、工作区半成品留给下一轮继续。

### U4 agent git 只读白名单

保留 `status log show diff rev-parse reflog tag describe blame shortlog ls-files cat-file`；删除 `add commit branch checkout switch merge restore stash`，连同 `gitCreatesCommit` 与 harness 侧 `ensureVersionBranch` 调用。生成指令改为：git 只读，用于理解项目与查看本轮未提交改动；版本由平台记录、回退由平台执行。协议升 11，旧 harness 明确拒绝而非静默旧语义。

### U5 面板

线性清单：缩略图、标题、时间、当前标记（SHA == HEAD）。保留「与上一版比较改动文件与补丁」。删除泳道 SVG、分支选择器、合并/切换入口、「修改路径与分支」高级区。

### U6 回填

`npm run versions:backfill`：从 `004_versioning.sql` 建的那张旧 `app_version`（只读）读出 SHA 与概述，灌进 `version_record`，默认预演，幂等。git-native 时期散在分支上的微提交**不回填**（无法可靠区分轮次边界，噪声不值得固化）。标题缺失时可用 `summarizeVersion` 按 diff 补算。

## 顺带收口的已知缺陷（来自全仓扫描）

- 采纳分支非幂等（version-store #4）→ adoptBranch 整体删除。
- 先释放租约再提交版本（server-core #3）→ U3 的 `beforeRelease` 钩子修正顺序。
- 版本写与生成准入无互斥（#1）的 ready 路径 → 提交与插行都在租约内完成；restore 原有租约拦截不变。
- e2e 手抄图布局常量（tests-int #4）→ 图删除。
- 两个预存失败用例（「模型自己提交过就不再重复提交」族）→ 旧语义删除，用例按新语义重写，预存失败随之消失。
- 可选项（评审定夺）：version-store `withLock` 陈旧锁按 mtime 盲删（#5），趁 U2 顺手加持锁 PID/续期校验，或留扫描台账。

## 验证与验收门禁

每单元：`type-check` + `npm test` + 聚焦集成。最终序列：U1→U6 全量 integration（独占测试库）→ `verify.mjs` 跑 version-panel（改了 tsx 追加 `--dev` 跑 dev-warnings）→ 证据按技能规约归档 → `versions:backfill` 真实库 dry-run。

关键旅程：连续两轮成功产出两版、两钉、两行；中断后重放同一 generation 不重复落账；回退 v3 再成功一轮，清单仍线性且各版可回退；最终验证未通过的那一轮不留版本；git 工具写操作全部拒绝；agent 读到的 log 每条 message 是一轮总结。

## 已定

1. git-native 时期散在分支上的微提交不回填，清单从上线时刻开始积累（历史仍在 git，可按 SHA 手动回退）。
2. 清单保留「与上一版比较」（改动文件与补丁），每行只跟紧邻的上一版比，用户不用自己挑两版。
3. `withLock` 陈旧锁顺手修：读锁里的 pid，进程已死立刻接管，活着才退回 mtime 上限。

## 实施记录（按实际代码回填）

- 台账主键是 `(app_id, commit_sha)`：提交只在各自仓库里唯一，同一秒、同内容、同身份的根提交在不同应用里会撞成同一个 SHA，用单列主键会静默丢掉一行。
- 落账不放在 `finishGeneration` 的事务里。台账行引用 `generation(id)`，而那个事务正对这一行持 `FOR UPDATE`，换个连接插子行会在外键检查上自锁。实际顺序是：事务一写定状态并留在租约 → 租约内跑钩子（自身连接写库）→ 事务二释放租约。
- 「提交即一版」由 `commitVersion` 自己保证：提交、钉引用、插台账行在同一把文件锁内完成，标题在这处定稿（空标题按改动文件兜底），钩子只负责给出 agent 总结与 `generationId`。
- 自愈仍在 `version-heal.ts`（协调层），`version-store` 只新增只读的 `listVersionPins` / `emptyVersionRepo` / `versionObjectExists`。
- 回填脚本的命令名是 `versions:ledger`（`versions:backfill` 已被「把没有 git 提交的工作区补成第一版」占用），默认预演，`--apply` 才写库。
- 标题链路在评审后改过一次：原计划「插行即终稿，用 agent 原话」，实际改成「先用便宜模型写一句页面上看得见的变化，写不出来才用 agent 原话，再不行按文件兜底」。产品叙事是原型网页，用户靠一眼看页面认版本，所以标题要写视觉变化，不能出现文件名、行数、代码；模型调用 6 秒超时，仍在提交之前完成，因此仍是一次写入、没有异步改写。
- 验证：单测 367/367；集成 228 过 / 1 跳 / 0 败（含真实 harness 的生成收尾四条）；`verify.mjs` 跑 version-panel 13/13，证据在 `.pi/skills/verify-paimeng-agent/evidence/2026-10-22T17-36-10/`。首页 home-parity 有 5 条预存失败，基线 `e1a9135` 复现同样 5 条，与本次无关。
- 真实库已执行 `005` 迁移与 `versions:ledger --apply`：78 条旧记录里 7 条能对应到 Git 对象，其余 71 条的提交对象从未进过应用仓库（回退不了，故不列）。
- 面板动作合并过一次：「使用这个版本」与「根据这版修改」调的是同一个回退接口，差别只在后者顺手收起面板。现在只留「使用这一版本」，点完回退、收起面板、光标进输入框；当前所在版本禁用该按钮。
