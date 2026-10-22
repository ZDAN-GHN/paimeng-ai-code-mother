# Git 作为唯一版本事实源：并行执行计划

用户已授权实施与 subagent 并行开发。基线：`feat/version-git-native` / `5b27276`，开始时工作区干净。交付目标是本分支的可验收改动；不推送、不合 main、不在真实应用上做排查性写操作。

本计划取代 `version-git-native.md` 中「回退新增提交」「版本表同步」的规则。执行参考：`/home/zdan/.agents/skills/multi-phase-plan/references/execution.md`。

## 用户可见结果与不变量

- 干净工作区点击回到旧版：只切到该 commit（detached HEAD），版本节点数和各分支头完全不变。
- 从旧版实际修改后提交：先创建独立分支，提交以旧版为父；原主线及其后续提交保持原样。
- 版本身份是完整 commit SHA，界面显示短 SHA 与概述，不再维护另一套 UUID 或 vN 序号。
- 历史、当前版本、分支、合并关系、提交时间从 Git 读取；不读写三张版本表，也不把这些事实改存 JSON。
- 概述以 commit message 为主。旧版 AI 概述和兜底提交的异步概述可以存在可选 JSON 展示缓存中；缓存没有 HEAD、分支、拓扑、版本清单。截图按 commit SHA 命名。缓存丢失可重新生成，不影响 Git 历史。
- 切版遇到未提交源码改动：拒绝并说明需要先提交/暂存；不自动新增「切版快照」，不 clean 掉未提交素材。构建产物与依赖不算源码改动。
- 每次切版仍执行真实构建并返回 previewError；运行中的 HTTP 写操作仍被租约拦截。
- 只保留安全闸对分支删除、非快进覆盖的限制；切换 detached HEAD 合法。创建、提交、合并用正常 Git 语义。
- 读路径不初始化仓库、不补写 config/hooks；防止截图与删除并发重建孤儿 `.git`。

## 冻结契约（U0）

冻结类型已写入三个隔离工作树的 `src/shared/versioning.ts`（内容即下文的字段定义）。主工作区保持可运行的原契约，等 U1/U2/U3 交付、集成时再一次性切换，避免半完成的契约打断正在跑的服务。子任务不得自行修改共享类型；需要变更时联系主代理。

- `AppVersion.id` 就是 SHA；含 `title/createTime/parents/heads/changedFiles/fileCount/bytes/thumbnailKey`。删除旧的 seq/kind/prompt/generationId/branch/superseded 等镜像字段。
- `VersionPosition` 使用 `kind: 'branch' | 'detached'` 判别联合；detached 不伪造分支名。
- 分支 `merged` 来自 Git 的祖先关系。绘图 branch 只是配色选择，不当成提交的唯一所属分支。
- 现有 HTTP 路径与 versionId 参数名保留；参数内容改为完整 SHA。截图和 diff 同样使用 SHA。
- `listVersions(app, {query?,limit?})` / `getVersion(app, sha)` / `versionGraph(app)` / `diffVersions(app, baseSha, targetSha)` 保留函数名，数据从 Git 读取。
- `commitVersion({app,title}) -> AppVersion|null`：只对真实源码变化提交；detached 时提交前自动建分支。删除 syncFromGit 及其补 PG 记账流程。
- `ensureVersionRepo(app) -> .git 路径`：显式写入口初始化/迁移普通仓库；`ensureVersionBranch(app) -> 分支名`：供 Agent commit 前调用，detached 时建分支，不创建 commit。
- `restoreVersion({app,versionId,guard?}) -> {status:'restored'|'unchanged',version}`；`branchFromVersion({app,versionId,label?,guard?}) -> {branch,version}`；`switchBranch({app,branch,guard?}) -> {branch,version:AppVersion|null}`；`adoptBranch({app,branch,guard?}) -> {branch,version:AppVersion|null}`。guard 在写锁内执行。
- `setVersionTitle(app,sha,title)` 只写可选展示缓存；`saveVersionThumbnail(app,sha,bytes)` / `versionThumbnailPath` 只写/定位图片，不写 PG。
- `versionBlockedReason` 移至 business 层；存储引擎完全不 import db/schema。store 的 overview.blocked 返回 null，由鉴权后的业务入口补充租约状态。

## 拆分依据与共享资源

这是多边界改造：Git 存储、HTTP/面板消费、Agent 运行时可分别验证。U0 是阻塞准备；U1/U2/U3 在同一冻结契约上并行；U4 集成所有产物。共享可变状态包括契约文件、测试 PG、端口、node_modules 和 Next 生成目录。契约归主代理；每个写者独占 worktree；各有 runtime/.next；node_modules 只读复用。子代理不跑全量集成、浏览器或长期服务；主代理在集成后串行运行这些检查。

当前资源：约 5 GB 可用内存、load≈1。运行三个编码子任务，避免并行拉起 Next/Chromium/Docker。

## 单元与所有权

| 单元 | Owner / 独占文件（均相对 paimeng-ai-code-agent） | 依赖 | 隔离位置 | 当前状态 |
| --- | --- | --- | --- | --- |
| U0 | 主代理：本计划、src/shared/versioning.ts | 无 | 主工作区 | 契约已冻结 |
| U1 | worker：src/server/version-store.ts、src/server/git-guard.ts、tests/integration/version-store.test.ts、tests/integration/git-guard.test.ts；可新增同边界 Git 测试 | U0 | ../.pi-worktrees/git-source-store | 工作树已就绪，待派发 |
| U2 | worker：src/server/business.ts（版本相关段）、src/app/api/[...path]/route.ts（版本参数校验）、src/components/chat/version-{panel.tsx,panel.css,graph.tsx}、tests/integration/version-api.test.ts、tests/e2e/version-panel.spec.ts | U0 | ../.pi-worktrees/git-source-ui | 工作树已就绪，待派发 |
| U3 | worker：src/server/durable-engine.ts（版本收尾）、src/server/durable/{harness-server.ts,git-args.ts,protocol.ts}、src/server/generation-instructions.ts、tests/integration/version-generation.test.ts、tests/integration/durable-m1/{git-tool,build-tool}.test.ts | U0 | ../.pi-worktrees/git-source-runtime | 工作树已就绪，待派发 |
| U4 | 主代理：schema 清理、version-thumbnail.ts、version-summary.ts、scripts/backfill-version*.ts、迁移脚本、package.json、tests/version-{summary,ing}-*.test.ts、文档；集成与最终验证 | U1/U2/U3（并行期只准备迁移与外围适配） | 主工作区 | 待开始 |
| U5 | 新上下文 reviewer，只读检查最终 diff 与真实验收证据 | U4 | 集成工作区只读 | 待开始 |

同一个 worktree 只有一个写者。不动其他会话、真实应用、服务和旧 worktree。所有产物保存为所负责文件的 patch 与简短 handoff；不自动提交、不 push。

## U1：让版本直接来自 Git

输入是冻结契约、旧 version-store.ts、安全 hook 和已有回归用例。用 Git log/refs/HEAD/diff 输出同一套版本数据；移除 PG 镜像和 reconcile 机器。列举历史时只取本地分支、明确的保留 refs、当前 HEAD，排除 stash/notes 冒充页面版本。支持没有数据库连接的读写核心测试。

显式初始化旧裸库时保留 SHA 与现有工作区，不强制 checkout；旧库保留备份，不用 rename 抹掉唯一来源。失去分支引用的老提交由 U4 导入为 `refs/paimeng/versions/<sha>`，读图包含该命名空间但不把它画成用户分支。新的 detached 提交在分支上落地。

验收：干净回退前后 commit 集合与 refs/heads 相同；HEAD=目标、工作区等于目标；新提交父=目标且 main 不变；切分支不增提交；合并祖先无操作/快进/分叉冲突正确；空改动不提交；只有忽略文件变化不误报；脏源码拒绝切换且字节不变；读取缺失仓库不重建；已知提交不因列表 limit 消失；图的双父连线正确；hook 允许 detached 切换。

运行聚焦 Git 集成用例，输出退出码与日志；不要为过时的全项目类型错误修改别的单元。handoff 给 U4：patch、文件清单、实际命令、结果、未决问题。

## U2：HTTP 与版本面板使用 SHA / detached 状态

输入是共享类型与 U1 函数契约。移除「回退追加一版」的说明；当前选中历史版时显示「历史版本」及其短 SHA，分支选择器不伪装为 main。版本行以概述+短 SHA 标识；标记由真实 HEAD 与 heads 产生，不把别的分支误标「已回退」。分支采用 Git 推导的 merged；保留拓扑 SVG、截图、diff、previewError 和忙态保护。

HTTP 恢复/分支/采纳/切换返回形状保留；业务层鉴权、租约判断和构建仍执行，缩略图 UUID 校验替换为共享 SHA schema。API 用例去掉 app_version 查询，改断言真实 Git HEAD/refs/文件与版本节点数。

验收：mock E2E 更新为共享类型构造；回退后列表节点数不变/current 是旧 SHA；detached 能切回原分支；当前版按钮禁用；预览地址更新、重建失败如实提示；SHA 校验覆盖截图与 diff。本地仅跑静态 UI/E2E 检查，完整浏览器和真 API 测试由 U4 集成后运行。

## U3：Agent 切版和提交遵守同一 Git 语义

输入是共享类型与 ensureVersionBranch/commitVersion 等 U1 契约。工具描述与系统指令改为「git switch --detach <sha> 回到旧版，不提交；修改后先建分支再提交」。git 工具在第一次使用时初始化仓库，commit 前 ensureVersionBranch；不强制把 detached HEAD 接回旧分支。保留参数安全校验与工作区边界。

生成收尾删除 syncFromGit 与 PG 记账；commitVersion 仅兜底真实脏改动。只有切版、没有修改时不得产生提交/分支；Agent 自提交后不重复提交。截图按当前 SHA；标题取 commit message，必要时异步概述只覆盖展示缓存。协议升为 10，避免旧 harness 静默执行旧语义。

更新 faux 模型契约测试：Agent rollback-only 不新增 commit；从 detached 实际编辑产生独立分支；未提交修改兜底一次；手动提交不重复。子任务只准备测试并做离线静态检查，真 harness 集成由 U4 独占测试库后运行。

## U4：迁移、外围适配和集成验收

- 显式迁移命令默认 dry-run；从旧三表读取 SHA、旧概述、截图映射；不重新生成任何旧 commit、不修改旧分支指针、不丢弃 detached/无 ref 但表内存在的提交。导入保留 refs、可选标题缓存，复制旧 UUID 文件名截图为 SHA 文件名。重复执行幂等，记录失败而不谎报成功。
- 运行时代码移除旧表声明/查询；历史 SQL migration 不改写、不执行 DROP TABLE，旧表只作为只读迁移来源。原 scripts 只按 Git 判断是否已有基线。
- 缩略图/概述适配新 AppVersion；图片缓存不再需要表行。修掉后台截图读路径创建 repo 的回归，保持截图来自该 SHA 的文件。
- 本分支应用 patch 后检查所有跨边界引用；真迁移验收只使用隔离测试数据或复制的真实应用。开发库只读，不靠手工修改真实 Git 指针证明功能。
- 证据目录：`/tmp/git-source-validation/`，记录基线、最终 diff hash、命令退出码、测试汇总与截图；交付摘要写回本计划。不要吞掉测试退出码，不用 grep|head 当最终验证结果。

集成验收顺序：聚焦 version-store + API + generation + git-tool → npm run type-check → npm run check:fast → npm test → 全量 integration（独占测试库，保存完整日志）→ 隔离 version-panel E2E + dev-warnings。

关键真实旅程：创建 A/B 两个提交 → 面板/真 API 回到 A → Git commit 集合和各分支头不变，HEAD=A、预览=A → 从 A 修改并提交 C → C.parent=A、main=B，面板能读到 A/B/C → 合并后源分支与主线各自新增文件都在，冲突不覆盖；删除标题缓存后仍可查看/回退全部 Git 版本。

性能不声称提升；仅验证少量版本历史没有 N 次 Chromium 并发（沿用串行截图）。若 Git 列表由逐提交子进程导致明显卡顿，测量并在本次修正。

## 验收门禁与交付状态

- [x] 用户授权、基线、工作区状态、接口与写边界已明确。
- [x] U1/U2/U3 产物落盘并经主代理检查（三份 handoff + 逐文件核对）。
- [x] 旧数据迁移脚本落地并在真实库上预演（默认 dry-run）；运行时不再查询旧版本表。
- [x] U4 类型/静态/单元/集成/浏览器检查通过（见下方实证）。
- [x] U5 独立评审完成并放行：另一模型家族三轮共 11 条，全部修复或判定为合理取舍，最终结论「可以合并」。
- [x] 所有本次启动的临时进程关闭，最终汇报包含证据和未决限制。

若遇到未批准的产品选择或基础设施失败，保存 patch 并上报。不得切换到外部 CLI agent 作为隐式降级，不得在真实应用上重写提交来让测试通过。

## 本次派发结果（2026-10-21）

> 后续：pi-subagents 已于当日 23:39 更新，parent-wake.js 恢复 COMPLETION_ACTION 导出，冒烟子代理运行成功；派发阻塞已解除。

Workflow `682b0bf5-e83a-441c-a09c-ee6f3d1750ec` 已终止，无活动子代理。U1/U2/U3 均在 runner 启动阶段失败：`../../shared/parent-wake.js` 未导出 `COMPLETION_ACTION`；检查发现本机 pi-subagents 0.80.0 的调用方和 .d.ts 引用了该导出，实际 parent-wake.js 只有 PARENT_WAKE_TEXT，安装内容不一致。没有持久化 child session，不能 resume，只能修复运行器后同协议重新派发。

三个隔离工作树仅包含主代理复制的计划与冻结契约，无子代理业务改动。主工作区的共享源码已恢复至原内容，避免准备中的新契约打断现有服务；计划和契约草案保留。未改全局插件，未启动长期服务。

## 实施结果（2026-10-21）

三个隔离工作树（`../.pi-worktrees/git-source-{store,ui,runtime}`）各自交付后，主代理按文件全量并入并做外围适配：

| 单元 | 交付要点 |
| --- | --- |
| U1 存储 | `version-store.ts` 重写为纯 Git：不再 import db/schema；`restoreVersion` 只切 detached HEAD 不提交；`commitVersion({app,title})` 只对真实改动提交（detached 时先 `ensureVersionBranch`）；`adoptBranch` 祖先=无操作、落后=快进、分叉=`merge-tree` 三方合并且冲突如实报错；`refs/paimeng/versions/*` 作为保留引用参与历史但不画成用户分支 |
| U2 接口与面板 | 版本身份=SHA；`VersionPosition` 区分 branch/detached；行标识用概述+短 SHA；`versionBlockedReason` 移到 business 层（存储层零 PG）；HTTP 的 diff/thumbnail 用共享 SHA 校验 |
| U3 Agent 链路 | 指令改为 `git switch --detach`；git 工具 commit/merge 前 `ensureVersionBranch`；收尾删除 `syncFromGit` 记账，只兜底真实脏改动；`harnessProtocol` 9→10 |
| U4 外围 | `version-summary/thumbnail` 适配 SHA；`versions:backfill` 改为按 Git 判断基线；新增 `versions:migrate`（旧表 → 保留 refs/概述/截图，默认预演）；`schema.ts` 移除三张表声明；`docs/plans/versioning.md` 标记退役 |

验证（本机）：

```text
npm run type-check                               0 error
npm run check:fast                              通过（25 tsx / 14 spec / 边界一致）
npm test                                        353 passed / 37 files
integration（全量）                              225 passed | 1 skipped / 32 files
E2E version-panel（隔离 3020/3021）               13 passed
npm run versions:migrate（真实库，dry-run）        识别 7 条主应用历史 + 其余应用，未写入
```

集成过程中修掉一处用例自身的测量错误：`commitCount()` 原先用 `git rev-list --count HEAD`，回退后 HEAD 就在旧版本上，必然只数到 1 个；改为 `--branches HEAD` 去重计数。

已知限制：E2E 夹具用 `versions-app` 这个非数字 appId，部分未被拦截的请求会在服务端日志留下 `Cannot convert versions-app to a BigInt`（测试仍全过，属夹具命名遗留）；vue/react 版本仍无离屏截图（提交里不含 dist）。

## 独立评审与修复（两轮）

评审在另一模型家族上跑，只读、无 shell，我给的是 `git diff` 文件而不是让它在仓库里跑命令。

第一轮（对 83b485b）判 BLOCK，5 条：

| 级别 | 发现 | 修复 |
| --- | --- | --- |
| P1 | `git status` 不报 ignored 文件，`read-tree --reset -u` 却会覆盖它们 | 切版前逐路径核对目标树：已跟踪改动、未跟踪同名、ignored 同名、目录占位都算冲突；与目标树无关的依赖/产物放行 |
| P1 | 迁移脚本用 `cat-file -e` 的 stdout 判真假，成功时输出为空 → 每个有效提交都被判缺失 | 迁移逻辑抽成 `version-migration.ts`，用失败返回区分；预演也做真实存在性核对；写入失败非零退出 |
| P1 | git 工具按子命令名无条件建分支，空提交/dry-run 会留下空分支 | 改为先执行，只有「成功且 HEAD 真的移动」才建分支 |
| P2 | 单个坏提交的批量 `diff-tree` 失败会让整个面板打不开 | 逐提交降级，`ls-tree` 统计失败不再抛 |
| P2 | 「截图来自指定提交」的行为用例被删且无替代 | 按 SHA 恢复：两版截图字节不同、工作区第三种内容不影响、二次命中缓存 |

第二轮（对 cbec2d6）仍有 2 P1 + 2 P2，全部修复：

- **父目录被普通文件占住**：`stat('section/index.html')` 只报 ENOTDIR，被当成不存在。改为 `pathOccupation` 逐级核对每个路径组件，读不出来的错误一律按冲突拒绝。
- **提交后挂分支失败被吞**：改用保留引用兜底（`refs/paimeng/versions/<sha>`，面板会读），并把「已保留 / 没保住」如实写进工具输出。
- **迁移混淆「读不了」与「不存在」**：`cat-file` 权限失败的最后一行同样是 `Not a valid object name`；改成 present/missing/unverified 三态，unverified 计入失败并非零退出。用 `chmod 000` 对象文件实测才发现这个分类错误。
- **未知统计显示成 0**：`AppVersion.statsKnown`，读不出来的树显示「统计不可用」而不是「0 个文件」。

两处修复都做了反向验证（改回旧实现用例即红），避免「测试通过但没测到东西」。

第三轮（对 ddea0bf）剩 2 条 P2，已修：合并提交补读差异也按单项降级（上一轮 commit message 声称已修但代码未落地，这处是我的失误）；仓库探测改成 ok/absent/unreadable 三态，absent 也归入「无法确认」并非零退出，且写入路径不再为历史已消失的应用凭空建仓库。评审确认关闭，并核对了两个边界：已删除应用不会阻塞整批迁移、旧裸库迁移路径仍然有效。

未做运行验证的两处（已在评审中如实标注）：①「批量 diff-tree 成功后对象被并发删除」的时序；②「旧裸库存在 + 工作区无 .git」的完整 apply 旅程（只做了源码路径核对，迁移逻辑的等价场景由 version-migration 用例覆盖）。

## 界面术语：Git 只留在底层

版本面板默认只出现四种人话：这一版长什么样（截图）、改了什么（概述）、什么时候（时间）、「使用这个版本」「根据这版修改」。
提交 SHA、分支、合并、树状路径收进「修改路径与分支（高级）」按需展开——产品面向非技术用户，默认视图不该出现 Git 的说法。
底层不变：还是 Git 提交、detached 切版、零新增。「根据这版修改」只多做一件事：收起面板并把光标交回输入框，用户直接说下一句需求。
焦点必须等抽屉关闭动画结束后再抢（`Drawer` 的 `afterOpenChange`），并且要重试几帧：antd 关闭确认框与抽屉时会各自把焦点还给触发按钮。

## 最终验证（ddea0bf）

```text
npm run type-check                        0 error
npm run check:fast                        通过
npm test                                  353 passed / 37 files
integration（全量）                        234 passed | 1 skipped / 33 files
E2E version-panel（隔离 3020/3021）         13 passed
npm run versions:migrate（真实库，预演）     234 项待处理，0 条无法确认
git-tool（真实 harness + faux 模型）        13 passed
version-migration（真实 git 仓库）          4 passed（孤儿提交/幂等/缺失/unverified）
```
