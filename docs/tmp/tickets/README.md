# MVP Ticket Graph（本地草案，未发布）

- 来源：[MVP 实施计划](../../tasks/mvp-plan.md)、[MVP 任务草案](../../tasks/mvp-todo.md)、[MVP 工程规格](../../specs/mvp-engineering-spec.md)。
- Tracker：项目权威 tracker 为 GitHub；本目录是本轮 GitHub 发布输入，发布结果和原生依赖图将记录在本文件。
- 状态：`published; blocked pending decision tickets`。

## 图例

- `D-*`：维护者决策或架构选择 Ticket。
- `T-*`：实施或验证 Ticket。
- `Blocked by` 只表达工程前置条件；下游编排可在 Ticket 批准后进一步拆解为可服务子问题。

## Ticket Graph

```text
D-06 -> T-01 -> T-02 -> T-03
D-07 --------------------^
D-01 -> T-04 ------------> T-05 -> T-06 -> T-07 -> T-08 -> T-09 -> T-10 -> T-11 -> T-12
D-02 ---------> T-05 ------------------------------^
D-05 -----------------> T-06
D-03 ----------------------------------------------> T-09
D-04 ----------------------------------------------------------> T-11
D-06 -----------------> T-05, T-08
```

## Ticket 清单

| ID | Ticket | Blocked by | Decomposition |
| --- | --- | --- | --- |
| D-01 | 固定模板、ORM 与 Migration 工具决策 | 无 | `architectural` |
| D-02 | Sandbox 与 Deployment 执行后端决策 | 无 | `architectural` |
| D-03 | 公共 URL 与 TLS 最小策略决策 | 无 | `architectural` |
| D-04 | 订阅运营参数与外部接入范围决策 | 无 | `architectural` |
| D-05 | Snapshot 物理存储选择 | 无 | `architectural` |
| D-06 | Task 与 Run 状态转换矩阵 | 无 | `architectural` |
| D-07 | Application 删除与数据保留语义 | 无 | `architectural` |
| T-01 | Platform 核心领域、状态机与 TaskExecutionBaseline | D-06 | `decomposable` |
| T-02 | Owner 管理、删除与 Requirement 接收 API | D-07、T-01 | `direct` |
| T-03 | Owner 初始入口、删除与 Requirement 界面 | T-02 | `direct` |
| T-04 | TS Agent Runtime 与 Pi Adapter 基线解析 | D-01、T-01 | `direct` |
| T-05 | Runtime 执行能力、Lease 与 Sandbox Tool Contract | D-02、D-06、T-01、T-04 | `decomposable` |
| T-06 | Snapshot、Profile 处置与 Validation/Evidence 契约 | D-05、T-01、T-05 | `decomposable` |
| T-07 | 权威 Validation、Migration Gate 与版本晋升 | D-01、D-02、T-05、T-06 | `decomposable` |
| T-08 | Requirement 到受控 Run 的执行闭环 | D-06、T-02 至 T-07 | `decomposable` |
| T-09 | 首次 Release、Deployment 与健康公开入口 | D-02、D-03、T-06 至 T-08 | `decomposable` |
| T-10 | 后续发布确认、Production 状态与 Owner 可见性 | T-03、T-08、T-09 | `decomposable` |
| T-11 | 订阅生命周期、状态 API 与 Owner 可见性 | D-04、T-09、T-10 | `decomposable` |
| T-12 | 跨服务验收、运行安全与交付文档 | T-01 至 T-11 | `decomposable` |

## Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户请求与 `docs/tasks/plan.md`。
- Target: 生成可审查的本地 Ticket Graph。
- Input / evidence: 7 个决策门、12 个实施任务及其计划依赖。
- Non-goals: GitHub 发布、代码实现、技术方案决策。
- Affected scope: `docs/tmp/tickets/`。
- Acceptance criteria: 每张 Ticket 包含模板必填字段；图中依赖均指向存在的 Ticket。
- Planned validation: Markdown 字段、数量、引用、空白与敏感信息扫描。
- Risks: 未决决策被误写为已批准，或虚假 blocker 限制后续编排。
- Rollback: 删除本目录新增文件。
- Escalation decision: 无；D-01 至 D-07 在各自 Ticket 中保持待维护者决定。

## Delivery Record

- Final status: `delivered`
- Change summary: 新增本地 Ticket Graph 索引、7 个决策 Ticket 与 12 个实施 Ticket；未创建、更新或关闭 GitHub Issue。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- |
  | `rg --files docs/tickets -g '*.md'` 加票据计数与模板字段检查 | 本地 Ticket 草案目录 | `passed` | `0` | 19 张 Ticket 均含模板必填段落。 |
  | `rg -o '\\]\\([0-9][0-9]-[^)]*\\.md\\)'` 加目标文件存在性检查 | 本地 Ticket Graph | `passed` | `0` | 全部 `Blocked by` 链接解析到存在的 Ticket。 |
  | `git diff --check --no-index /dev/null docs/tickets/*.md` 逐文件检查 | Git 空白检查 | `passed` | `1`（新增文件差异的预期退出码） | 无空白错误。 |
  | 敏感信息赋值模式扫描 | 本地 Ticket 草案目录 | `passed` | `1`（无匹配的预期退出码） | 未发现凭据或密钥赋值。 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户请求、`docs/tasks/plan.md`、`docs/tasks/todo.md`。 |
  | Scoped diff / baseline | `git diff --no-index /dev/null docs/tickets/<file>.md`，全部新增本地文档。 |
  | Actual validation evidence | 上述数量、模板、依赖、空白与敏感信息检查。 |
  | Review method | 有界主 Agent 审查；`code-review` Skill 不适用，因为未提供提交基线且新增文件未跟踪。 |
- Review findings: 无 P0/P1；图中的每个计划 ID 都有一张 Ticket，D-01 至 D-07 维持为 blocker，`TaskExecutionBaseline` 与 `ExecutionCapabilities` 仍按计划分层。
- Review conclusion: 清晰；本地 Ticket Graph 符合计划和本次“仅生成、不发布”的边界。
- Unresolved risks / blockers: D-01 至 D-07 未决，相关实施 Ticket 保持阻塞；本目录不是 GitHub 原生依赖图。
- Rollback: 删除本次新增的 `docs/tmp/tickets/` 目录；不影响 GitHub、代码、配置或生产环境。
- Maintainer decisions / waivers: 本地生成获得用户明确授权；未记录任何产品或架构决策。

## Review Follow-up Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户针对 T-08、T-09、T-10 本地 Ticket 的审查意见。
- Target: 将既有 Product Layer 与 Release 行为从“存在测试”提升为可观察的 Ticket 验收。
- Input / evidence: `R-002`、`R-006`、`AC-019` 至 `AC-022`、Product Layer Boundary，以及三张 Ticket 当前内容。
- Non-goals: 不创建新 Ticket、不改变 Ticket Graph 依赖、不发布 GitHub Issue、不实现功能。
- Affected scope: `docs/tmp/tickets/15-requirement-controlled-run-loop.md`、`16-first-release-deployment.md`、`17-subsequent-release-confirmation.md`，及其计划同步文档。
- Acceptance criteria: Owner 状态/澄清路径、首次失败公开可见性、后续发布三项 Production 行为均作为可观察验收，不只写为测试存在。
- Planned validation: 目标 Ticket 与计划的关键短语、依赖链接、Markdown 空白和敏感信息扫描。
- Risks: 只改 Ticket 不同步计划会造成追溯漂移；将内部状态误写为 Owner 可见会遗漏 Product Layer。
- Rollback: 还原本次涉及文档的验收文本；不影响 GitHub 或实现。
- Escalation decision: 无；行为已由已确认规格定义。

## Review Follow-up Delivery Record

- Final status: `delivered`
- Change summary: 票据目录的外部移动已适配为 `docs/tmp/tickets/`；T-08 增加 Owner Product Layer 状态、唯一阻断答复和权限验收；T-09 增加首次失败未上线/无健康 URL/诊断脱敏验收；T-10 增加确认前、确认后和失败/回滚的可观察 Production 验收。`docs/tasks/plan.md` 与 `docs/tasks/todo.md` 已同步。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- |
  | Ticket 数量和模板段落检查 | `docs/tmp/tickets/` 本地草案 | `passed` | `0` | 19 张 Ticket 均含模板必填字段。 |
  | `Blocked by` 目标和 README 来源链接检查 | 本地 Ticket Graph | `passed` | `0` | 所有内部 Ticket 链接和计划/规格来源链接存在。 |
  | T-08/T-09/T-10 审查补救短语检查 | 目标 Ticket | `passed` | `0` | Owner 状态/答复、首次失败未上线、后续发布三项 Production 行为均已明确。 |
  | `git diff --check --no-index /dev/null <file>` 逐文件检查 | Git 空白检查 | `passed` | `1`（新增文件差异的预期退出码） | 无空白错误。 |
  | 敏感信息赋值模式扫描 | 本次文档范围 | `passed` | `1`（无匹配的预期退出码） | 未发现凭据或密钥赋值。 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户审查意见；`R-002`、`R-006`、`AC-019` 至 `AC-022` 与 Product Layer Boundary。 |
  | Scoped diff / baseline | 三张目标 Ticket、`docs/tasks/plan.md`、`docs/tasks/todo.md` 与索引路径修正。 |
  | Actual validation evidence | 上述结构、链接、关键短语、空白与敏感信息检查。 |
  | Review method | 有界主 Agent 规格对照和文档审查；不涉及代码或提交基线。 |
- Review findings: 进入本轮时有 2 项 P1 和 1 项 P2；三项均通过显式可观察验收和计划同步处理，未发现新增 P0/P1。
- Review conclusion: 清晰；T-08、T-09、T-10 不再将核心行为降格为“有测试”。
- Unresolved risks / blockers: D-01 至 D-07 仍未决；本目录仍是本地草案，未发布 GitHub。
- Rollback: 还原本轮涉及的 Ticket、计划和索引文本；不影响 GitHub、代码、配置或生产环境。
- Maintainer decisions / waivers: 无新增决定；本轮仅落实已确认规格。

## GitHub Publish Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户明确要求“发布为 github issue”。
- Target: 将 7 个决策 Ticket 与 12 个实施 Ticket 创建为 19 张 GitHub Issue，并按 Ticket Graph 写入原生 `blocked_by` 依赖。
- Input / evidence: `docs/tmp/tickets/`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、Issue #65。
- Non-goals: 修改/关闭/评论 Issue #65，创建 Subagent，指派人员，开始实现，关闭任何 Issue。
- Affected scope: GitHub 仓库 `ZDAN-GHN/paimeng-ai-code-mother` 的新 Issue 与其原生依赖边；本地发布记录。
- Acceptance criteria: 恰好创建 19 张新 Issue，均含 `ready-for-agent`；每条原生依赖边与本地 Ticket Graph 一致；父 Issue #65 不变。
- Planned validation: `gh issue view` 核对标题/标签/正文；GitHub dependencies endpoint 核对每张阻塞 Ticket；确认 Issue #65 的更新时间和评论数未变。
- Risks: 重复创建、依赖方向反转或中途 API 失败。
- Rollback: 保留已创建 Issue 编号和依赖证据；关闭或删除已创建 Issue 需要用户额外明确授权，绝不触及 Issue #65。
- Escalation decision: 用户已授权创建 Issue；若创建或依赖 API 失败，停止后报告已创建编号和失败边。

## GitHub Publish Delivery Record

- Final status: `delivered`
- Change summary: 已创建 19 张 GitHub Issue `#66` 至 `#84`，均使用 `ready-for-agent`；已创建 46 条 GitHub 原生 `blocked_by` 依赖。未修改、关闭或评论父规格 Issue #65。
- Issue mapping: `D-01` `#66`，`D-02` `#67`，`D-03` `#68`，`D-04` `#69`，`D-05` `#70`，`D-06` `#71`，`D-07` `#72`；`T-01` `#73`，`T-02` `#74`，`T-03` `#75`，`T-04` `#76`，`T-05` `#77`，`T-06` `#78`，`T-07` `#79`，`T-08` `#80`，`T-09` `#81`，`T-10` `#82`，`T-11` `#83`，`T-12` `#84`。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- |
  | `gh auth status`、`gh label list`、`gh issue view 65 --json ...` | GitHub tracker preflight | `passed` | `0` | 已登录，`ready-for-agent` 存在；Issue #65 为开放且未被本轮写入。 |
  | 全部本地标题对 GitHub Issue title 精确匹配检查 | GitHub tracker duplicate preflight | `passed` | `0` | 创建前未发现同标题 Issue。 |
  | `gh issue create` 按 01 至 19 顺序执行 | GitHub tracker | `passed` | `0` | 创建 #66 至 #84，均附 `ready-for-agent`。 |
  | `gh api .../dependencies/blocked_by` | GitHub 原生依赖端点 | `passed` | `0` | 46 条边的 child/blocker 集合与本地 Graph 一致。 |
  | `gh issue view 65 --json ...` | 父规格保护检查 | `passed` | `0` | Issue #65 仍开放、1 条既有评论、更新时间未变化。 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户发布指令、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、本地 Ticket Graph。 |
  | Scoped diff / baseline | 新建 GitHub Issue #66 至 #84 与原生依赖边；未写 Issue #65。 |
  | Actual validation evidence | 创建输出、标签/模板核验、46 条依赖集合和父 Issue 核验。 |
  | Review method | 发布前重复标题检查、发布后 GitHub API 对照本地依赖图。 |
- Review findings: 无 P0/P1；未发现重复 Issue、标签漂移或 native/body blocker 图不一致。
- Review conclusion: 清晰；GitHub Issue Graph 与已批准本地 Ticket Graph 一致。
- Unresolved risks / blockers: D-01 至 D-07 仍是开放决策 Issue，并按原生依赖阻塞下游实施；未开始任何实现。
- Rollback: 已创建 Issue 和依赖边可定位；关闭或删除它们需要用户额外明确授权，Issue #65 不在回滚范围内。
- Maintainer decisions / waivers: 用户明确授权 GitHub Issue 发布；没有新增产品或架构决定。

## GitHub Sub-issue Start Record

- Status: `active`
- Task type: `change delivery`
- Source: 用户指出“这些 issue 是为了实现 spec 的票，应该 spec issue 的子 issue”。
- Target: 将 Issue #66 至 #84 建立为父规格 Issue #65 的 GitHub 原生子 Issue。
- Input / evidence: #65 当前无子 Issue；#66 至 #84 当前均无父级；本地 Ticket Graph 与既有 46 条 blocker 依赖。
- Non-goals: 修改 Issue 正文、标签、状态、既有 blocker 图或 Issue #65 的正文/评论；创建新 Issue；开始实现。
- Affected scope: GitHub Issue #65 的子 Issue 关系，以及 #66 至 #84 的 parent 关系；本地发布记录。
- Acceptance criteria: #65 精确列出 #66 至 #84 为子 Issue；每张子 Issue 的 `parent` 为 #65；46 条原生 blocker 依赖保持不变。
- Planned validation: GitHub `sub_issues` endpoint、`gh issue view --json parent`、依赖端点计数与父 Issue 状态/评论核验。
- Risks: 子关系 API 失败、部分挂接或意外改变 blocker 图。
- Rollback: 记录成功挂接的子 Issue；移除子关系需要用户额外明确授权，不能关闭或删除任何 Issue。
- Escalation decision: 用户明确授权建立子 Issue 层级；若 API 失败，停止并报告已挂接数量。

## GitHub Sub-issue Delivery Record

- Final status: `delivered`
- Change summary: 已将 #66 至 #84 全部建立为父规格 Issue #65 的 GitHub 原生子 Issue；既有 46 条 `blocked_by` 依赖、Issue 标签、正文与状态未改变。同步更新 `docs/tasks/mvp-plan.md` 和 `docs/tasks/mvp-todo.md` 的重命名链接与发布状态。
- Actual validation:

  | Command | Existing entry point | Status | Exit status | Sanitized result / blocker |
  | --- | --- | --- | --- |
  | `gh api repos/.../issues/65/sub_issues --paginate` | GitHub 子 Issue REST 端点 | `passed` | `0` | 精确返回 #66 至 #84，共 19 个子 Issue。 |
  | `gh issue view <66-84> --json parent` | GitHub Issue parent 投影 | `passed` | `0` | 19 张 Ticket 的 parent 全部为 #65。 |
  | `gh api .../dependencies/blocked_by` | GitHub 原生依赖端点 | `passed` | `0` | 46 条 blocker 边的集合未变。 |
  | 标签核验 | GitHub Issue 列表 | `passed` | `0` | #66 至 #84 均保留 `ready-for-agent`。 |
- Review evidence:

  | Required input | Record |
  | --- | --- |
  | Task goal / acceptance source | 用户子 Issue 指正；`docs/agents/issue-tracker.md`。 |
  | Scoped diff / baseline | #65 的子 Issue 关系、#66 至 #84 的 parent 关系，以及本地计划索引的路径/发布状态修正。 |
  | Actual validation evidence | REST 子 Issue 列表、每票 parent、原生依赖与标签核验。 |
  | Review method | GitHub REST/API 对照本地 Ticket Graph。 |
- Review findings: 无 P0/P1；`gh issue view --json subIssues` 的 GraphQL 投影未返回完整集合，已采用 REST `sub_issues` 端点作为权威验证，未造成 tracker 漂移。
- Review conclusion: 清晰；全部实现 Ticket 均属于规格 Issue #65，且 Ticket Graph 的 blocker 图保持完整。
- Unresolved risks / blockers: D-01 至 D-07 仍未决并阻塞对应实施 Issue；未开始实现。
- Rollback: 已创建的子关系可定位；移除任何子关系需要用户额外明确授权，不能关闭、删除或修改 Issue #65 正文/评论。
- Maintainer decisions / waivers: 用户明确授权子 Issue 关系；未新增产品或架构决定。
