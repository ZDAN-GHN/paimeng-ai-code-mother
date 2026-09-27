# Issue #78: Snapshot、Profile 处置与 Validation/Evidence 契约

## Context

- Issue #78 / `docs/tmp/tickets/13-snapshot-validation-evidence-contract-v2.md` 要求将可写 Workspace 冻结为不可变 CandidateSourceSnapshot，并为 Profile 处置和验证证据建立受限的持久契约。
- 物理存储已决定为每 Application 一个 Platform 私有 Git 仓库；本阶段不执行权威 Validation、不创建 SourceRevision 或 Trusted Profile Version。
- 上游 Issue #77 已关闭；当前 Java Platform 已有 Task/Run 基线、Lease、Sandbox，TS Agent 已有 Runtime/Platform Client，但尚无 Snapshot/Validation 实现。#78 不执行权威验证，不晋升 SourceRevision/Trusted Profile Version，也不扩展对外 Git/CI 写入。
- `PlatformSandboxExecutor` 使用容器内 tmpfs `/workspace` 且禁止宿主机 bind mount；冻结必须在停容器前由 Platform 通过 Docker API 提取并校验文件树，不能直接从宿主机读取 Workspace。现有执行 Controller 无身份鉴权、仅 feature flag + loopback；内网回环请求不能被当成“内部可信 Validation”。

## Approach

- Runtime 成功时先请求冻结，再上报 `SUCCEEDED`；Platform 对该 Run 串行化命令/冻结、核验有效 fence 和 `EXECUTING` 状态，在稳定采集窗口提取容器内文件。必须验证 Docker API 对暂停容器的归档读取能力；若不支持，实施时采用同等可证明的停止写入机制，不能在可能并发写入的文件树上标记可信 Snapshot。限制大小/文件数/类型，拒绝 `.git`、symlink、逃逸路径、hooks、submodule、外部 LFS 和不安全权限；由 Platform 在私有仓库创建不可变 commit，写入绑定 Application/Task/Run、基线摘要、baseSourceRevision、commit/tree hash 和处置的 Snapshot。`SUCCEEDED` 必须核验已冻结的同 Run Snapshot；失败按现有 FAILED 清理/补偿路径处理，不把失败的冻结当成功。
- 使用显式参数的本地 Git 进程（禁用继承的 Git 配置/钩子/remote，固定工作目录和超时）与 Docker archive 流的结构化 TAR 解析；当前 pom 未声明直接的 TAR 解析依赖，若需要显式增加，实施前核实版本/许可证/安全性并取得依赖批准。Git 可执行文件及 Platform 私有持久卷是新增部署前置条件，启用前验证，不自动安装。
- 为每次冻结使用稳定 requestId 和唯一约束；写 Git 对象后再落库，DB 失败允许无引用对象保留并安全重试，绝不在请求尚可能引用时 GC。所有读/恢复路径复核 commit/tree 完整性，启动前检查迁移与仓库可读；并发或重试时不同文件树不得共用同一逻辑 Snapshot。
- 恢复操作仅按数据库登记的 commit/tree hash 从私有仓库读取并复核，目标须为空且归属正确的隔离 Workspace；不从可移动 branch/tag 还原。仓库根目录设在 Platform 独占持久卷，不落入 `runtime/tmp/` 的临时源码空间。
- Profile 处置保存 `changed | unchanged | uncertain`：changed 必须提供候选 Diff、归属 Requirement 和理由；unchanged 必须有理由；uncertain 允许留痕但不能有成功验证。只校验确定性完整性，不宣称自动判断业务语义。
- Validation/Evidence 只暴露 Platform 内部服务/仓储写接口，由后续受信任验证器调用；记录 Snapshot 身份、验证类别/结果、不可变证据引用和幂等键；拒绝 Runtime/Agent 可达的“结果直接写入”端点、自报 actor、跨 Application/Task/Run 的错配或可变 Snapshot、重复键冲突、`uncertain` 的通过记录。运行结果上报不等于权威验证；T-07 负责真实 gate 执行与状态晋升。

## Files to modify

- `paimeng-ai-code-backend/src/main/java/com/zdan/paimengaicodebackend/platform/`：新增 Snapshot/Validation 内部契约、存储与服务，扩展 `sandbox/PlatformSandboxExecutor.java` 的安全导出/恢复能力、`service/PlatformRunExecutionService.java` 和 `controller/PlatformRunExecutionController.java` 的受控冻结请求（精确类名待实现阶段确定）。
- `paimeng-ai-code-backend/src/main/resources/db/migration/V10__platform_snapshot_validation_evidence.sql` 和 `src/test/java/com/zdan/paimengaicodebackend/platform/`：新增迁移及集成测试（顺序若发生变化应按最新版本顺延）。
- `paimeng-ai-code-agent/src/engine/platformClient.ts`、`src/engine/runRuntime.ts` 及对应测试：协调执行成功时的受控冻结请求；Agent 不获得 Git 仓库或证据写权限。
- `paimeng-ai-code-backend/src/main/resources/application*.yml` 与必要的 `ops/` 部署配置：可配置的私有 Git 持久卷根，启动前检查目录和 Git 可执行文件；不将仓库共享给 Agent/Sandbox。

## Reuse

- `platform/domain/TaskExecutionBaseline.java`、`platform/service/PlatformRunExecutionService.java`、`platform/sandbox/PlatformSandboxExecutor.java`、`platform/domain/PlatformRunLeaseService.java` 和现有 Platform 迁移/集成测试。
- `paimeng-ai-code-agent/src/engine/{platformClient,runRuntime}.ts`、`paimeng-ai-code-backend/src/test/resources/contracts/task-execution-baseline/`；私有 Git 仓库目前未找到现成实现。

## Steps

- [x] 核实上游 #77 与 D-05、Run 成功上报和 Sandbox 销毁顺序、tmpfs 与当前回环围栏；T-06 必须在 `reportResult(SUCCEEDED)` 前冻结，不暴露验证写 HTTP 入口。
- [ ] 新增受审计 Docker archive 导出/恢复、私有 Git commit 存储、冻结幂等持久记录；验证暂停容器时导出，并在成功上报前强制存在同 Run Snapshot。
- [ ] 实现并测试 Profile Diff 处置与拒绝非法组合。
- [ ] 实现并测试仅内部可写的 Snapshot-bound Validation/Evidence 契约，不开放外部通过结果写入接口。
- [ ] 执行端到端验收、审查改动和回滚风险。

## Verification

- Java 单元与 DB 集成测试：同 Run 冻结去重/冲突、非法路径/符号链接/忽略文件、大小限制、基线与归属错配、Git 成功但 DB 失败恢复、对象丢失/篡改、未冻结即成功上报、`uncertain`/无 Diff 的处置、Validation 仅内部可写与错误证据拒绝。
- 必须在可用 Docker 和 Sandbox 镜像的环境验证真实 tmpfs 导出/恢复、暂停期间源码稳定性及容器终止后 commit 仍可恢复；不可用时记录验收阻断，不把跳过的集成测试当通过。TS 跨服务夹具验证冻结请求/响应、成功和失败的上报顺序及不含证据写权限。
- 后端 `cd paimeng-ai-code-backend && ./mvnw verify`；Agent `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build`；复查迁移、开放路由与改动 diff。执行部署/数据迁移前需另行明确授权。

## Risks and rollback

- 风险：旧 #77 Runtime 可能仍上报无 Snapshot 的 `SUCCEEDED`，故同步发布 Java/TS 或通过功能开关阻断旧客户端；本地 Git 与私有卷不可用时禁止宣告可冻结。回环围栏不是身份鉴权：冻结仅接收已有 fence，Validation 写入绝不可经 HTTP 暴露；若要求跨主机调用须另立鉴权任务。
- 回滚：关闭新冻结入口并保留新表/已冻结 Git 对象及引用；代码回退不得删除或 GC 引用对象。恢复旧 Runtime 前必须协调成功上报契约，不能仅回滚一侧。此计划获批后才进入代码、依赖和迁移实施。
