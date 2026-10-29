# Harness 可靠性重构与 pi-durable 1.4.0 升级计划

> **Archived 2026-10-29.** This is the historical implementation record, not current operating guidance. Current deployment and contracts live in [`pi-durable-deployment.md`](../../pi-durable-deployment.md) and [`implementation-contract.md`](../../implementation-contract.md); the durable decisions extracted from this plan are in [ADR-0001](../../adr/0001-single-writer-authority.md), [ADR-0002](../../adr/0002-immutable-delivery.md), and [ADR-0003](../../adr/0003-sdk-as-engine.md). Evidence links under `.agents/` preserve the paths used at the time and may no longer resolve.

## 目标与范围

从当前 `main` 重建生成链路，先统一升级至 **pi-durable / pi-ai / chord 1.4.0**，再完成执行隔离、持久输入、恢复门禁和原子发布。

实施在 `refactor/harness-reliability` 分支上进行，从 `main` 切出；分支上的工作按下面的实施顺序分阶段提交验收，不自动推送，也不以阶段完成推断整个计划完成。

已确认：

- 完整覆盖生成、steer、followUp、取消、ask、恢复、验收、版本和预览，并适配下载与部署。
- 失败或取消后，下一轮默认承接**停止写入并封存的草稿**，复制到新的执行目录。
- ask 仅允许在本轮首次源码修改前调用；回答开启新 generation。
- harness 重启后，编辑中的 generation 失败并保留草稿；checking/publishing 自动对账恢复。
- 恢复历史版本立即切换预览，并重置下一轮草稿起点，不新增版本行。
- 第一版采用单主机、单 harness 写进程，支持多个 app 并发。

首轮提速、autofix、组件块库、跨机器调度、付费模型评估及生产迁移执行不在本次范围。

## 0. 先完成 SDK 升级与存储兼容

### 版本基线

npm 当前 latest 为 `1.4.0`。仓库 package.json/package-lock.json 固定 `1.3.0`，当前 node_modules 实际为 `1.4.0`；此前评审中将安装代码标注为1.3.0的描述一并更正。

将现有三个直接依赖精确固定为：

- `@earendil-works/pi-durable: 1.4.0`
- `@earendil-works/pi-ai: 1.4.0`
- `@earendil-works/chord: 1.4.0`

同步生成锁文件，使 pi-codemode、pi-telemetry 等关联传递依赖按发布要求统一解析为1.4.0。保持其他直接依赖版本不变，不添加无实际用途的 SDK 包，不采用浮动版本。

### 必须完成的兼容改造

- 自定义 `storage-pg.ts` 的 task 状态 CHECK 当前不包含 `sleeping`。在其独立 SDK 存储迁移序列中新增 **version 2**，扩充约束；不修改已执行的 version 1，不重置执行库。
- 扫描、序列化、恢复和诊断支持 sleeping，保留 checkpoint、唤醒时间、restarts 和 blocked reason。SDK 状态与产品四相位分开，不把 sleeping 直接解释成产品任务结束。
- `runModelDoc` 增加必填 `checkpointWhen: () => true`，该小型配置文档直接保存完整 base；不改变文档数据结构或伪造版本迁移。
- 自定义 Context 和测试替身包含 telemetry；优先复用 SDK/Chord 提供的上下文。运行时/工具包装完整转发 `now`、`sleepUntil`、`setTimer` 等1.4.0接口，不继续使用被删除的 `TaskRuntime.sleep()`。
- 适配 `onReport(error, info)`、task_parked 和 restart_limit。保留 SDK 默认 `restartLimit=5`；产品编辑任务遇到 parked 按 interrupted 收束并保留草稿，不自动 retryTask。
- 显式设置 `afterFailedRun: 'withdraw'`，避免失败后 SDK 自动执行排队输入；产品输入文本和 unanswered 状态仍然保留。
- 模型门和工具包装兼容新版 `api.models` identity wrapper，不依赖它与原始 Models 对象引用相等。新增 telemetry 仅作诊断，不作为授权或幂等事实。

应用使用自定义 Postgres Storage，不套用上游 SQLite 自动迁移。SDK 存储 version 2 和产品迁移006分别管理。升级后旧适配器应明确拒绝较新 schema，回滚通过升级前备份恢复，不能仅降 npm 版本继续打开新数据。

### 升级验收

先在隔离测试环境验证：全新安装与锁文件一致、三个直接依赖及关联 SDK 包无版本混用、旧版 PG 数据升级后可读取、sleeping 写入/扫描/重启唤醒正常、parked 可诊断、文档重开正常、模型绑定与凭据引用不变。使用 SDK Storage conformance suite 加项目回归，不调用真实 provider。

## 1. 修订所有权、分层与持久模型

Next 负责鉴权、意图适配和订阅；长驻 harness 内的 Controller 负责持久状态推进。事件用于唤醒，启动扫描与周期对账补足漏事件；read 不再执行接管或收尾。

内部保留 `editing / checking / publishing / finished`；公开保留 `generating / building / ready / failed / cancelled`。草稿 draining/sealing 作为交接状态返回给 UI，不增加 generation phase。

| 边界 | 职责 |
|---|---|
| ControlStore | 准入、输入状态、预算、lease、终态及原子校验 |
| SDKAdapter | execution 与 conversation/task/submission 关联、实际调用门、停止与对账 |
| Workspace | 固定目录、基线复制、写入准入、排空与源码封存 |
| Delivery/Publisher | 快照验收、Git 内容、版本与预览指针原子发布 |

`generation_lease` 改为每 app 永久 authority 行：单调 owner_epoch、进程启动标识、可空 holder、过期时间、交接状态和草稿引用。释放只清空 holder，不删除 epoch；execution 保存取得的 token，不形成另一份所有权权威。

控制事务固定锁顺序为 app → authority → generation → attempt。准入、撤销、接管、finish 和发布采用同一协议；心跳条件更新不能复活过期 owner。时间判断使用数据库时钟，事务内不执行 provider、Git、文件操作或构建。

新增输入、执行绑定、源码快照、attempt、delivery、transition、question 与预览指针记录；用户手动部署/历史物化操作单独持久记录。约束包括：每 app 一个执行 owner、每 execution 固定目录与 conversation、app/requestId 幂等、一个新 generation 最多一个版本、一个 app 最多一个开放 question、新 published delivery 必须对应版本。

## 2. 工作区隔离与默认承接草稿

执行目录固定为 `runtime/executions/<generationId>/<epoch>/`。新 generation 使用独立 conversation，禁止修改旧 conversation 的 cwd 来交接。工具及平台 helper 都使用绑定到该 execution 的文件能力。

基线顺序固定为：当前封存草稿 → 当前版本源码 → 新 app 模板。模板初始化和附件物化属于基线准备；模型工具及素材导入发起的源码变更计为本轮修改。路径、符号链接、平台保留文件、配额与 owner 校验集中在 Workspace，实际 execute 再次准入。

失败/取消交接：

1. 控制事务撤销 epoch、关闭新 effect 准入、写终态，authority 进入 draining。
2. abort 普通和后台任务，关闭文件写入准入，等待已进入 writer 退出。
3. 独占封存：复制到临时快照、计算摘要、原子转入最终目录并登记。
4. 更新 app 草稿引用，结束 draining，下一轮复制该快照。

封存未完成时，start 返回 `DRAFT_SEALING`；前端保留 requestId 重试，不创建重复任务，不静默回退到旧版本。无法确认 writer 停止则维持阻塞并报错。崩溃后由取得存储独占锁的新进程清理旧构建子进程，再封存残留源码。

草稿保存父版本、输入和 SDK 上下文关联。下一轮继承已提交历史，并明确中断原因和实际源码基线；应用聊天按 execution 聚合，继承条目按 entry ID 去重。

发布必要性比较最终源码与**当前预览源码**，避免遗漏上一轮草稿中的修改。ask 不再声称工作区没有未版本化内容；它只限制本轮首次修改之前提问。

## 3. 持久输入、ask 与公开接口

接收时分配单调 inputSeq，区分 `accepted / placed / resolved / withdrawn / unanswered`；输入表兼作待交付记录。

- 产品提交后再交付 SDK，requestId 由 input ID 确定；重复提交复用原键，相同键不同内容返回冲突。
- SDK entry 回执确认 placed，submission/answer 成功回执确认 resolved；撤回保留记录。
- 完成水位是连续已解决前缀，不能取乱序结果最大值。
- 候选记录实际完成输入水位。发布要求覆盖全部已接受输入，且没有 pending、placed 或待执行 followUp。
- checking/publishing 期间接受新输入使旧候选失效，回到 editing，保留预算与 deadline。
- 终态后的消息创建新 generation。中断后未完成输入显示 unanswered，文本保留，不自动重跑模型。

公开意图接口统一为：

- `start({requestId, appId, message, modelAlias, expectedQuestionId?})`
- `input({requestId, appId, generationId, expectedSeq, mode, message})`
- `withdrawInput({requestId, appId, generationId, inputId})`
- `cancel({requestId, appId, generationId})`
- `read(appId)` 与订阅接口。

调用方不指定 epoch、phase、路径或 attempt。取消不要求 expectedSeq，按 generationId 防误伤，区分 cancelled、already-cancelled、already-published、already-finished。回执包含 inputId、sequence 和状态，SDK submissionId 在尚未交付时可空；输入冲突时保留客户端文本并同步当前序号。

ask 使用 sequential execution mode，禁止嵌套调用；与写入 reservation 在同一控制事务中互斥。成功后登记问题、关闭后续 effect，控制器在工具返回后排空剩余任务并收束，不依赖单个 terminate 结束整轮。回答消费和新 generation/input 创建同事务完成。

## 4. 实际 effect 门与保守恢复

不 fork SDK，不用自定义 task 替换内环。

生成期间只开放 SDK 生成和阻塞压缩，关闭后台压缩；不开放手动压缩、deferred、模型图片生成和分类器入口。现有生成前业务分类保持原用途，不混入 generation 内环预算。

beforeRequest/beforeCompact 提供 task 关联；真正授权、预算预留和发出意图在模型 facade 执行。每 execution 最多一个模型操作，关联不唯一则拒绝。调用键由 execution、SDK task、operation、发出前分配的调用序号组成；sessionId 只用于会话路由。raw provider 不暴露给工具。

attempt 保存请求摘要、epoch、输入水位、用量和结果引用。sent 表示可能已发出，unknown 不重发；失败结果不等于无副作用。晚到回执可精确补记事实，但不能复活任务或移动预览。所有写工具和外部副作用工具设 SDK replay unsafe；只读工具即使 safe，实际 execute 仍检查 execution。未分类工具拒绝。

启动顺序：

1. effect 门默认关闭，取得 SDK 存储独占锁并装配适配器。
2. 只读 inspect 产品与 SDK 记录，不提前调用会启动 scheduler 的等待接口。
3. 遗留 editing 撤销 epoch、对账 attempt、标记 failed/interrupted，清理旧任务并封存草稿，包括 sleeping/parked 编辑任务。
4. checking 从快照在新 build attempt 目录重建；publishing 对账 Git 与产品事务后继续或确认已完成。
5. 恢复完成后开放新任务。submit、abort、wait 等入口同样受启动屏障约束。

保留 `GENERATION_TIMEOUT_MS` 的既有语义：正数变为持久 deadline，0 表示无全局 deadline；followUp、repair 和重启不延长。次数预算始终生效：模型24次（含压缩）、工具400次、自检构建2次、平台构建3次、repair最多2轮，并服从现有更低 repair 配置。单次超时取配置与剩余 deadline 的较小值。

provider 和 SDK 普通错误自动重试关闭。确定的上下文溢出允许 SDK 阻塞压缩后创建新请求，计入预算。新版本的 sleeping、crash guard 和 telemetry 不替代这些产品协议。

## 5. 不可变验收、版本和交付消费者

模型自检仅返回诊断；平台验收对封存源码执行现有依赖/锁文件检查、类型检查与构建。第一版不新增设计 lint 或浏览器 smoke 阻断。

每个 build 使用独立临时目录；输出与 manifest 完整封存后进入 ready，禁止原地重建。源码失败在预算内 repair，环境失败终止并保留草稿。

版本从源码快照构造 tree/commit，使用专用 app Git 内容库，保留既有对象和 SHA。版本列表只读 version_record，不再依赖移动共享工作区 HEAD 同步状态。标题由本轮文本和确定性 fallback 生成，不额外调用摘要模型。

发布事务按统一锁协议校验 owner、终态、deadline、输入水位、封存回执与父版本，使用同一事务句柄原子写入版本、delivery、预览指针、草稿起点、generation completed 和转移记录。取消先提交则拒绝发布；发布先提交则返回 already-published。

所有消费者走统一 DeliveryResolver：

- 预览入口跳转到固定 delivery URL，HTML/JS/CSS/图片不跨交付混用；首次发布前不回退工作区。
- 工程采用相对资源 base，静态资源在构建时规范化路径。
- 下载读取交付源码快照，封面和缩略图读取对应版本产物。
- 历史恢复切换到已有验收 delivery；legacy 版本先独立物化验收，最终事务重查 app 空闲和指针 revision，再切预览与草稿起点。失败保持原状态，不追加版本行。
- 部署捕获已验收版本，复制/构建/截图在事务外，完成后原子更新部署引用；失败不影响预览。每 app 同时一个部署操作，requestId 幂等。

只自动回收终态拒绝候选、孤儿临时目录和过期草稿。版本、当前草稿、预览、部署及进行中操作引用的内容均保留。

## 6. 迁移、实施与切换

产品库新增 `006_harness_control.sql`，不修改旧迁移或补造003；SDK PG 存储另增内部 migration version 2。整个升级和重构的 harness 协议由当前11统一升至12，Next 与 harness 配套升级。

保留现有用户、应用、版本、消息和旧工作区。当前预览与未发布草稿分别导入并标 legacy，不伪造其一致性或版本行；旧版本允许暂缺 delivery，新生成数据必须满足完整约束。

实施顺序：

1. **SDK升级（已完成于本分支）**：更新精确依赖和锁文件，适配文档/上下文/运行时接口，完成 PG sleeping 迁移与升级回归。
2. **修订蓝图与SDK契约测试**：纠正旧版本、012迁移、17协议及旧分支实验结论；在1.4.0上锁定恢复、压缩和 ask 行为。
3. **ControlStore与输入闭环**：永久 authority、输入状态、幂等准入、预算和事务竞态。
4. **隔离执行与草稿交接**：全部 writer、conversation绑定、取消、启动屏障和默认承接草稿。
5. **验收与原子发布**：不可变快照、Git内容库、版本/指针事务、checking/publishing恢复。
6. **消费者与前端**：预览、历史恢复、下载、部署、封面、聊天及输入状态。
7. **迁移演练与清理**：在测试副本演练切换，删除旧 observer、读状态触发接管、共享工作区发布和旁路写入，更新运行文档。

切换前备份两个数据库和 runtime，停止新准入并排空旧执行，再迁移、导入 legacy 和启动新协议。引用核对失败时不开放生成。回退必须恢复匹配的数据库与运行目录，不允许旧 SDK 打开升级后的存储。

## 实施状态（refactor/harness-reliability）

第 2–7 步已在本分支落地并通过 `npm test`（393）、`npm run type-check`、`npm run check:fast`、完整 integration（365，最终日志见证据目录）、system（17）、既有隔离 E2E（119，另有 verify-paimeng 证据用例）与 dev 告警门禁（2）：控制面 006、authority/epoch、持久输入与水位、独立 execution/conversation、写入门禁、草稿封存、不可变交付与预览指针、发布事务、ask 及回答新 generation、启动恢复与观察者重挂。

仍保留的边界：`generation_lease` 仍保留给旧测试/旧数据，生产新生成只使用 authority；provider/SDK 的既有重试策略保留（模型配置测试依赖失败步骤记账），未按早期草案强制关闭；legacy 应用没有版本/草稿/模板时把当前工作区作为基线；历史恢复优先切已有交付，legacy 版本才重新构建并物化；legacy 导入工具与演练文档已落地，但生产副本上的实际切换演练未执行；生产迁移、生产重启与开发仓库提交也不在本分支执行。

补充完成：业务写路径（部署、下载、删除、预览重建、版本切换）统一检查新 authority/未收束 execution 与运行中部署；`app_deployment` 已接入手动部署，提供 requestId 幂等、每 app 单 running、失败保留错误和超时回收；`generation_attempt` 已接模型/工具/构建预算（24/400/2/3 + repair 2），持久 deadline 按数据库剩余时间计时，checking/publishing 新输入作废候选并恢复 editing；下载优先读交付源码快照；legacy 导入脚本与演练文档已落地；版本恢复用维护锁覆盖 Git/构建/交付全过程。

## 7. 测试与验收

证据根目录（相对仓库根）：`.agents/skills/verify-paimeng/evidences/26-10-29/`。逐项审计、失败归档和复现命令见 [`reliability/README.md`](../../../../.agents/skills/verify-paimeng/evidences/26-10-29/reliability/README.md)；本轮以 `paimeng666` 账号跑的三条隔离 E2E 见 [`account-proof/`](../../../../.agents/skills/verify-paimeng/evidences/26-10-29/account-proof/)（编排日志 `account-proof/commands/run-all-final.log`），每轮 launcher 日志在 `runs/`。

下表只记录实际执行过的命令或测试。`部分` 表示主路径已有执行证据，但 §7 原文中的某个边界仍未证明；边界在“结论与边界”列明确标出。

| # | 场景 | 验收标准 | 已执行证据 | 结论与边界 |
|---|---|---|---|---|
| 1 | 干净安装 1.4.0、旧 SDK 库升级 | 锁文件可重现；数据保留；关联 SDK 版本一致 | `commands/clean-install.log`（空目录 `npm ci`，exit 0，460 packages）；`commands/npm-ls.log`（`pi-durable`、`pi-ai`、`chord` 均 1.4.0）；`durable-sleep.test.ts` 的 v1→v2 用例 | **部分**：干净安装和版本一致通过；旧数据只在测试库做 v1→v2 结构升级，未做生产副本升级 |
| 2 | sleeping 持久化/扫描/重开、parked | 状态完整、诊断明确，产品不误判结束或自动续跑编辑 | `durable-sleep.test.ts` 2 个用例（写入/扫描、重开后续跑）；`durable-harness-report.test.ts` 的报告格式；启动扫描的 integration | **部分**：sleeping 通过；**parked 实际触发、重启和产品状态收束没有端到端用例**，只有报告格式和扫描代码 |
| 3 | runModelDoc、Context、工具包装与模型 identity | 通过类型及运行回归，重启后模型绑定和凭据引用不变 | `durable-m1/model-config.test.ts` 7 个用例，含运行中改 alias + kill -9、重启后 identity 不变 | **部分**：SDK 模型身份/凭据引用通过；session 没有产品 execution 绑定 |
| 4 | 旧工具放行后取消、新轮开始 | 新轮只复制封存草稿，无跨目录污染 | `durable-m1/restart.test.ts`（中断工具不重跑）；`execution-workspace.test.ts`（封存/草稿）；`generation-lifecycle.test.ts`（草稿继承） | **部分**：integration 通过；没有真实浏览器“已放行工具后取消”的断点用例 |
| 5 | writer 尚未退出时启动新轮 | 等待交接，不复制活动目录、不重复创建任务 | `execution-workspace.test.ts`（关门等待/超时）；`app-write-guard.test.ts`（authority/部署/生成准入） | **部分**：门闩和准入通过；没有跨进程真实 writer 的 E2E |
| 6 | 输入已接受但未 placed、followUp/撤回/repair 竞态 | 输入不丢，水位连续，旧候选不得发布 | `control-store.test.ts`（幂等/水位/撤回）；`generation-lifecycle.test.ts`（候选失效）；`chat-inputs.test.ts`（回执投影） | **部分**：后端竞态通过；**没有 accepted-before-placement 的真实服务端窗口**，浏览器覆盖仍含 stub |
| 7 | editing 模型 sent 后强制重启 | 不重发旧模型或写工具，失败与草稿可解释 | `durable-m1/model-config.test.ts`（kill -9 后旧模型/旧密钥继续）；`durable-m1/restart.test.ts`（中断工具不重放） | **部分**：SDK 进程级重启通过；不等于产品 generation/execution 的完整强制重启演练 |
| 8 | checking/publishing 各提交点重启 | 正确恢复，无重复版本、无缺版本预览 | `generation-lifecycle.test.ts`（发布/取消/待对账事务）；`recoverStartup` 的 integration | **部分**：数据库状态机对账通过；没有真实产品进程在 checking/publishing 被 kill 后的恢复演练 |
| 9 | lease 撤销/续租/接管并发 | 旧 token 无法推进状态，epoch 不回退 | `control-store.test.ts`（并发接管、epoch 单调、过期回收、旧 epoch 拒绝） | **通过（authority 范围）**：新 authority 路径通过；`generation_lease` 仍保留给旧测试/旧数据 |
| 10 | ask 与读写同轮、重复回答 | 无提问后写入，无双重 generation，无丢回答 | `account-proof/ask-question/` 新 E2E（1 passed；`proof.json`）；`durable-m1/ask.test.ts`；`ask-lifecycle.test.ts` | **通过**：真实 UI 提问暂停、无写入、回答开新 generation、重复回答 409；`[ask:...]` 只在夹具模型边界，认证/harness/预览是真实的 |
| 11 | 发布与取消并发 | 由事务顺序决定，已发布版本不回滚 | `generation-lifecycle.test.ts`（发布先提交/取消先提交/同 epoch 互斥） | **通过**：事务顺序与回滚断言通过 |
| 12 | 旧 HTML 加载资源、版本恢复/下载/部署 | 使用对应交付，恢复无新增版本，部署失败不改预览 | `account-proof/app-edit-publish/`（快照下载、部署幂等、attempt 账本；restore 是 `unchanged` no-op）；`account-proof/version-delivery/`（1 passed；两版真实切换、CSS/JS、ZIP、部署）；`preview-delivery.test.ts`；`download-delivery.test.ts`；`deployment-record.test.ts` | **部分**：真实跨版本切换/下载/部署主路径通过（app-edit 的 restore 只证明 no-op）；**旧文档在切换后继续请求旧资源**和**真实部署失败不改预览**未证明（失败路径目前是 mock） |
| 13 | 数据库故障和晚到回执 | 新 effect 拒绝，回执不复活任务 | `generation-budget.test.ts`（unknown→succeeded、终态不回退）；`generation-lifecycle.test.ts`（交付/版本失败补偿） | **部分**：晚到回执状态机通过；**没有真实数据库断连故障注入** |

### 未证明边界

- 生产数据副本迁移、生产迁移/重启未执行；只覆盖测试库（第 1 行）。
- `parked` 的实际触发、重启扫描和“不自动续跑编辑”没有端到端证据（第 2 行）。
- 产品 execution 在模型 `sent` 后强制重启、checking/publishing 中途 kill 未演练；跨进程 writer 接管未演练（第 5、6、7、8 行）。
- `accepted-before-placement` 的真实服务端窗口未在浏览器中复现（第 6 行）。
- 真实数据库断连未注入（第 13 行）。
- 旧 HTML 文档在版本切换后继续请求旧交付资源、真实部署失败后预览不变未证明；当前部署失败用例使用 mock，旧资源只验证当前交付的 CSS/JS（第 12 行）。
- 所有模型调用使用 faux/fixture provider；没有真实 provider 或生产流量证据。

证据目录中的分支最终 integration：**365 passed / 1 skipped**（`commands/integration-full-final.log`；本轮只改 E2E 证据代码，未重跑 integration）。本轮实际执行了 3 条 `paimeng666` 隔离 E2E（均见 `account-proof/`）、`npm run check:fast`、`npm run check:e2e` 和 `npm run type-check`。E2E 使用隔离 Next + harness + 预览，应用和存储强制指向测试库，模型使用仓库夹具。

unit 不启动数据库或子进程；Storage conformance、PG 竞态及 SDK 进程重启放 integration，Docker 构建放 system，页面流程放隔离 E2E。共享资源测试串行运行。

最终标准：无输入丢失、无未知调用自动重发、无跨执行目录污染、无重复版本、无新数据中的“预览可见但版本缺失”，并且锁文件能在干净环境重现同一 SDK 版本。
