# Pi Agent Core 迁移计划

## 背景与目标

- 使用 `@earendil-works/pi-agent-core` 替换 `@earendil-works/pi-coding-agent` SDK，移除上层 SDK、TUI 及不再需要的独有间接依赖，保留原本需要的工具能力与 Runtime/Platform 契约。当前锁文件有 227 个包条目；`pi-coding-agent@0.87.0` 引入 `pi-tui@0.87.0`，而 `pi-agent-core@0.87.0` 仍依赖 `pi-ai`、`pi-telemetry`、`chord`、`diff`、`ignore`、`typebox`、`yaml` 等包，不能一概删除。
- 原 AD-006 决策中的“Pi SDK”指仅提供 Agent loop 的薄引擎层，与当前引入完整 coding-agent 的实际情况不符；迁移时补充取代旧结论的决策记录。
- 非目标：改变 Task/Run 语义、开放宿主机工具、引入第二套 Agent 框架，或把目前仅提供健康检查的 HTTP 服务接入执行链路。

## 实施方案

- 每次 Run 创建独立的 `@earendil-works/pi-agent-core` `Agent`；通过 `@earendil-works/pi-ai` 的 `createModels()` 选取模型，并将 `models.streamSimple.bind(models)` 作为流函数。保留仅面向容器的系统提示词、内存中的对话记录，不发现宿主机上的 Pi 资源或会话。
- 保留项目自有的 `AgentEngineAdapter` 和 `SandboxOperations` 边界，**保留现有六个工具的能力**：`read`、`edit`、`write`、`bash`、`find`、`ls`，其中文件操作及 shell 执行继续发生在容器内。已核对 `pi-agent-core@0.87.0` 源码：其 harness 层提供 `read/edit/write/bash`（参数形状与 SDK 接近），但返回依赖 `ExecutionEnv` 的 `AgentHarnessTool`，无法直接用作低层 `Agent` 的 `AgentTool`，且没有 `find/ls`。因此先对照 SDK 的六个工具实现逐项列明输入校验、路径解析、文本编辑、输出截断、错误、取消及结果格式；复用 core 公开且可在 Sandbox 边界内安全调用的辅助能力，仅将其余必要逻辑适配为接入 `SandboxOperations` 的 `AgentTool`。`find/ls` 参考 SDK 源码及现有 Sandbox glob 逻辑迁移，不引入宿主机工具；禁止直接启用默认的本地 `ExecutionEnv`。
- 只注册选中的内置 provider 和显式配置的自定义模型，明确凭据来源。`createModels()` 不负责解析 SDK 的 `models.json`、`auth.json`：仅在传入 `modelsPath`/`authPath` 时读取，验证选中 provider 的配置和凭据；不支持或无效的选中模型配置必须明确报错，不能静默忽略。保留现有自定义 provider 测试样例及适用的 API key/OAuth 行为；密钥不得进入 Sandbox 命令环境、事件或错误信息。禁止从 `~/.pi/agent` 等位置隐式加载配置。
- 保持事件归一化、取消、provider 错误脱敏和 Run 结果的外部语义。选用 `toolExecution: 'sequential'` 保证写入和取消行为可预测，并在交付前检查它是否改变现有可观察顺序。
- 先用测试确认行为及隔离边界，再移除 `pi-coding-agent`，按 npm 标准流程重新生成锁文件。

## 预计修改文件

- `paimeng-ai-code-agent/package.json`, `paimeng-ai-code-agent/package-lock.json`
- `paimeng-ai-code-agent/src/pi/piEngineAdapter.ts`、`paimeng-ai-code-agent/src/pi/sandboxToolAssembly.ts`、`paimeng-ai-code-agent/src/pi/piModelCatalog.ts`、`paimeng-ai-code-agent/src/pi/piCredentialStore.ts`；只有 core 事件形状确有差异时才修改 `src/pi/piEventNormalizer.ts`。
- `paimeng-ai-code-agent/test/pi/piEngineAdapter.test.ts`、`paimeng-ai-code-agent/test/pi/sandboxToolAssembly.test.ts`、`paimeng-ai-code-agent/test/pi/piCredentialStore.test.ts`；只有事件语义变化时才调整 `test/pi/piEventNormalizer.test.ts`。
- `docs/specs/mvp-engineering-spec.md` 的 AD-006、`paimeng-ai-code-agent/README.md`。

## 复用现有实现

- `paimeng-ai-code-agent/src/engine/agentEngineAdapter.ts`：引擎边界和 Run 结果类型。
- `paimeng-ai-code-agent/src/engine/sandboxOperations.ts`：容器内有围栏的操作及路径/写入校验。
- `paimeng-ai-code-agent/src/pi/sandboxToolAssembly.ts`：工具白名单、Sandbox glob 匹配和六工具 Sandbox 接线；对照现有 SDK `dist/core/tools/{read,edit,write,bash,find,ls}.js` 的输入输出契约，以及 core `dist/harness/tools/{read,edit,write,bash}.js` 已提供的实现。不能直接复用 SDK 工厂返回对象，不能把 core harness 工具接到宿主机默认环境。
- `paimeng-ai-code-agent/src/pi/piEventNormalizer.ts`：现有事件协议和用量映射；若 core 的事件兼容则保持不变。

## 实施步骤

- [x] 核实 `pi-agent-core@0.87.0` 和 `pi-ai@0.87.0` 的工具、模型/认证、取消、事件 API；逐个对照 SDK 六工具源码和 core 四个 harness 工具，记录需要保留的参数、边界校验、文件及 shell 执行、错误/输出格式，确认可复用的公开辅助 API 与项目内最小适配范围。对照 SDK 的 `models.json` provider 和 `auth.json` 凭据格式，明确选中 provider 的支持字段及显式认证行为。
- [x] 用模拟流及模拟 Sandbox 网关补充定向测试（不调用真实 provider）：六工具名称与参数、宿主路径及密钥隔离、各工具结果/错误、模型选择与自定义模型、显式凭据加载、文本/工具/用量事件、错误脱敏、启动前和运行中取消、资源清理；断言工具调用进入有围栏的操作，而不是宿主机文件或进程。
- [x] 将 `PiEngineAdapter` 的 SDK 模型/会话初始化替换为每 Run 一个 core `Agent`；把原 SDK 的 `read/edit/write/bash/find/ls` 必需语义移到项目控制的 Sandbox 工具适配层，仅传入接到 `SandboxOperations` 的六个 `AgentTool`。保留工具参数/输出、文件编辑行为及 `matchGlobInSandbox`，使用隔离提示词、`toolExecution: 'sequential'`、`models.streamSimple.bind(models)`。将 `agent.state.messages` 和 `agent.abort()` 映射到现有 Run 结果，不丢失错误或取消；不修改共用的 `RunRuntime`/`PlatformClient` 契约。
- [x] 将 `pi-agent-core`、`pi-ai` 固定为直接依赖，移除 `pi-coding-agent`；使用 npm 生成 `package-lock.json`，不手工改锁文件。更新 AD-006，注明旧“Pi SDK”指薄引擎的原意及新决策理由；同步更新 Agent README。
- [x] 运行定向及完整验证，检查生产依赖树、SDK/TUI 是否移除和锁文件是否出现无关变动；处理审查中发现的工具错误语义、请求头、续读、选中模型配置及凭据权限问题。真实 provider 冒烟未运行，详见下方边界。

### 第一步取证记录

- `pi-ai@0.87.0/dist/models.d.ts` 与 `dist/index.d.ts` 明确导出 `createModels`、`createProvider`、`Models.streamSimple` 和 `CredentialStore`；`providers/all.d.ts` 导出 `builtinProviders`。现有 SDK `dist/core/model-runtime.js` 在其上额外装配文件配置与凭据。模型子任务仅查 SDK 文档得出“未确认 createModels”，已由目标包声明纠正。
- `pi-agent-core@0.87.0/dist/agent.d.ts` 的 `Agent` 支持 `initialState`、`prompt`、`subscribe`、同步 `abort`、`state.messages`、`toolExecution`；`dist/types.d.ts` 的 `StreamFn` 要求 provider 错误在流的终态表达。`dist/harness/tools` 只有 read/edit/write/bash，其 `ExecutionEnv` 签名不同于 `AgentTool.execute`；不得使用宿主机默认实现。
- 逐项对照 SDK `dist/core/tools/{read,edit,write,bash,find,ls}.js`：保留 read 的 `{path,offset?,limit?}` 及 2000 行/50 KiB 截断、edit 的批量唯一非重叠替换与 diff、write 的递归创建和反馈、bash 的 `{command,timeout?}` 秒数及尾部输出、find 的 `{pattern,path?,limit?}` 和忽略目录、ls 的 `{path?,limit?}` 及目录标记/排序。SDK 文件操作通过当前项目 `SandboxOperations` 注入，取消时底层网关并非都能中断；不能误报写回滚。SDK 包标识 MIT，直接复制源码前需确认再发行许可文本；本次仅参考行为契约。
- 选中 provider 的自定义 `models.json` 支持 `api`、`baseUrl`、`apiKey`、`headers`、`models` 等 SDK 字段；`auth.json` 记录为 `{provider:{type:'api_key',key}}` 或 OAuth。`pi-ai` 的 `CredentialStore` 可注入且负责 refresh 的序列化写入，`createModels` 自身不解析 JSON 文件；必须显式处理受支持字段、刷新持久化与无效选中配置，不能隐式发现主机 Pi 目录。

## 验收与验证

- 已执行（2026-09-26，最终一轮）：`npm ci --offline --ignore-scripts --no-audit --no-fund`、`npm run type-check`、`npm run test`（59/59）、`npm run build` 和 `npm ls --omit=dev` 均成功；生产直接依赖为 `pi-agent-core`、`pi-ai`、`diff`、Fastify、Zod。锁文件现有 171 个包条目，`pi-coding-agent` 与 `pi-tui` 均不存在。`git diff --check` 无空白错误。
- 补充回归：CRLF/BOM 编辑、patch 详情、shell 参数转义及非零退出码、长文件续读、自定义模型请求头和选中配置、OAuth 凭据原子写入/并发刷新及写失败原文件保留、宽权限凭据文件及符号链接拒绝。正确性审查提出的 3 项问题均已修复；安全审查提出的原文件权限问题已修复。真实 provider 调用需单独提供凭据，当前仅离线模拟。
- 在 `paimeng-ai-code-agent/` 下运行 `npm run test -- test/pi/piEngineAdapter.test.ts`、`npm run test -- test/pi/sandboxToolAssembly.test.ts`；若事件归一化有修改，还须运行相应测试。
- 同目录运行 `npm run type-check`、`npm run test`、`npm run build`；现有 `runRuntime`、`platformClient` 测试用于检查共享契约回归。
- `npm ls --omit=dev` 及锁文件检查须确认没有 `pi-coding-agent` 或 `pi-tui`；仅保留剩余生产依赖图确实需要的包。移除 TUI 不代表 `pi-ai` 的 provider SDK 也能移除。
- 安全及能力验收：六个 Sandbox 工具仍可完成原有文件读取、精确编辑、写入、shell 命令、查找及列目录操作，输入、输出、错误和取消与原工具保持兼容；操作进入有围栏的 Platform 网关。除显式 `modelsPath`/`authPath` 和 provider 认证外，不访问 Runtime 宿主机文件、进程及 Pi 资源。核对取消、错误事件及 Run 结果。

## 风险与回滚

- Core 的 `AgentTool.execute` 与 harness 工具工厂的契约不同；直接套用 harness 需要实现大范围的 `ExecutionEnv`，目前没有对应的安全 Sandbox 实现。若无法安全复用已有基础工具代码，则对照 SDK 源码把必要的文件和 shell 语义迁入项目适配层，测试锁定行为和隔离边界；使用原实现代码前核对许可条款及归属要求。
- 凭据和自定义模型目录格式原本由 SDK 处理，直接改用 core 会丢失这部分能力。仓库目前只有合成的自定义目录测试，没有生产目录文件；实施前需核实所选 provider 的配置及凭据刷新/持久化语义，不支持的设置必须明确报错。
- 引擎行为测试使用模拟流离线验证；真实 provider 冒烟测试为可选项，须显式提供凭据。若需回滚，应一起恢复 SDK 依赖及锁文件、适配器实现，不能只改依赖声明。
- 移除 SDK 默认设施不能削弱容器边界，也不能经 shell 工具泄露 provider 凭据。
- 凭据刷新持锁期间若进程强制退出，`.lock` 可能遗留；当前操作会明确超时失败，不在不了解持锁进程状态时自动删除锁。运维须确认没有活跃持锁进程后处理；该可用性限制留作后续具备所有权验证的锁恢复设计，不影响已有文件内容。显式 `authPath` 现要求 POSIX、本进程所有、普通文件及私有权限（`0600` 或更严格），部署时应提前校验。
- 旧 SDK 自定义模型的 `apiKey: "!命令"` 解析方式不在受支持范围：执行宿主命令会破坏隔离边界，迁移后对选中模型明确报错，不会将该字符串默认为真实 API key；应改为显式凭据文件或环境变量引用。

## 后续目录归位（2026-09-26）

- 状态：active；变更交付，R2（跨 `engine`/`pi` 模块引用，但不改变引擎或外部行为）。来源：维护者要求 Pi 专用代码归入 `src/pi/`。目标：`src/engine/` 保留通用 Engine/Runtime/Sandbox 合约，Pi Agent 适配、模型目录、凭据存储及 Pi 六工具装配归入 `src/pi/`；测试目录镜像源代码布局。
- 非目标：重新设计工具、凭据、模型或 Runtime 契约；不调用真实 provider、不修改 Issue #77 状态。历史证据：Issue #77 旧 SDK 当时完成 `xhy-api/gpt-6-luna` 实际模型和真实 Pi `write`/`bash` Sandbox 冒烟；本次 core 迁移之后未重跑真实 provider 冒烟。
- 验收：四个 Pi 专用文件和三个对应测试移动到 `src/pi/`/`test/pi/`；`engine` 保留通用操作与协议；不存在旧导入路径，运行行为不变。
- 验证：`cd paimeng-ai-code-agent && npm run type-check`、`npm run test`、`npm run build`，以及旧路径检索和 `git diff --check`。风险：跨目录相对导入及测试夹具路径失效；以类型检查、既有回归测试验证。回滚：仅反向移动这七个文件并恢复导入，不回滚已批准的 core 迁移。
- 交付记录：delivered。四个源文件与三个测试文件已归位；通用 `sandboxOperations.ts` 仅修正指向适配器的注释。实际验证：`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 退出码 0（59/59 测试）；旧 `engine/pi*` / `engine/sandboxToolAssembly` 路径检索无命中；`git diff --check` 退出码 0。审查方法：对当前未提交变更做主 Agent 限定范围审查（不具备 committed-diff `code-review` 前提）。Standards：导入方向、测试镜像和通用 Sandbox 边界无回归；Spec：七个文件归位且未修改行为，P0/P1 未发现。剩余未验证项：core 迁移后的真实模型冒烟不属于本次目录归位，仍未执行；回滚同上一条。

## 真实模型补充冒烟（2026-09-27）

- 范围：只验证 `pi-agent-core` 版 `PiEngineAdapter.run()` 连通真实 `xhy-api/gpt-6-luna`，并分别验证无工具响应与真实模型发起一次 `bash` 工具调用。显式指定本地私有模型目录；未将密钥、原始响应或工具参数写入记录。每次请求都设置 45/50 秒取消和 80/90 秒进程超时。
- 结果：无工具请求退出 0，Run `completed`，非空文本，事件 `execution.started`、`assistant.text.delta`、`usage.observed` 各 1。工具请求退出 0，Run `completed`，模型发起 1 次 `bash`，带 Run/Application/fence 的调用到达合成网关，事件 `tool.call.started`、`tool.call.completed` 各 1，`usage.observed` 2 次。
- 边界：工具请求的网关是内存桩，**没有**启动 Java Platform、申请真实 Lease、在真实容器内执行命令或写入数据库。本次不能替代 #77 旧 SDK 的真实 Sandbox/Run 端到端证据，也不证明 core 版本已通过完整受控执行链路。

## #77 密钥引用补验（已提交）

- 类型：事故修复与验收补测；风险级别 R3（密钥解析和外部测试模型请求）。来源：用户明确指定 `runtime/tmp/issue-77/` 的测试配置并要求重跑真实模型请求；此前两次冒烟不能证明使用 #77 凭据。
- 事实：`runtime/tmp/issue-77/models.json` 的 `xhy-api` `apiKey` 是 `$XHY_API_KEY` 引用，并非明文密钥；`paimeng-ai-code-agent/.env` 为本地权限 `0600` 的文件，包含对应变量。当前 `src/pi/piModelCatalog.ts` 只解释 `${ENV_NAME}`，会把裸 `$ENV_NAME` 当作字面量。此前对 `models.json` 权限导致明文密钥泄露的判断已更正，不作为安全事件记录。
- 目标/验收：兼容明确指定目录中的 `$ENV_NAME`；环境变量缺失时不将引用文本当密钥发送；用明确加载的本地 `.env` 对 `xhy-api/gpt-6-luna` 作一次有上限的真实调用，内存核对出站认证头与所选变量一致，得到非空回复和用量事件。无法从客户端证明提供商后台计费记录，须单列限制。
- 非目标：修改密钥文件、启动 Platform/真实 Sandbox、写入业务数据库、关闭 Issue、自动提交或证明完整 #77 受控 Run 链路。
- 验证：先对 `test/pi/piEngineAdapter.test.ts` 用现有 `tsx --test` 入口执行同一回归用例的 RED/GREEN；再运行 Agent `type-check`、`test`、`build`；最后执行短时、无原文输出的显式环境变量真实模型探针。失败时按失败类别停止，不在日志中显示密钥或模型原文。
- 风险与回滚：不要把原始认证头/环境值传到工具、日志或任务记录；只在进程内比较。异常请求须中止并结束进程。回滚仅撤销本节引入的目录解析、测试与文档变更，保留已获批准的 core 迁移范围。
- 修复前复现：`cd paimeng-ai-code-agent && ./node_modules/.bin/tsx --test test/pi/piEngineAdapter.test.ts` 退出码 1；新回归用例读到字面量 `$PI_AGENT_CORE_TEST_KEY` 而不是合成环境变量值，其他 10 个用例通过。修复后同命令退出码 0（11/11）。
- 首轮验证：`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 退出码 0（60/60 测试）；后来又增加 `${ENV_NAME}` 保持兼容和非法 `$...` 拒绝检查，最终门禁待完成。
- 真实模型调用：在 Agent 目录运行一次 `node --input-type=module --eval '[限时、脱敏探针]'`，从权限 `0600` 的 `.env` 只取 `XHY_API_KEY`，用 `runtime/tmp/issue-77/models.json` 指定 `xhy-api/gpt-6-luna`；退出码 0。进程内比较目录解析结果和出站 HTTP `Authorization`，均与所选变量匹配；真实出站请求 1 次，Run `completed`，非空文本，`execution.started` 1 次、`assistant.text.delta` 2 次、`usage.observed` 1 次，无工具调用，未触发 45 秒取消或 80 秒进程上限。探针只输出以上布尔值/计数，不输出密钥、模型原文或错误正文。
- 验收边界：本证据证明该 Agent 模型调用位置确实用 #77 指定的环境变量发出请求并收到响应；不证明提供商控制台计费记录、真实 Java Platform/Lease/Sandbox 的端到端链路。提交需先由用户审批提交信息；未暂存、未提交。
- 最终验证：增加 `${ENV_NAME}` 保持兼容及非法引用拒绝用例后，`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build` 再次退出码 0，60/60 测试通过；`git diff --check` 退出码 0。`git check-ignore -v paimeng-ai-code-agent/.env runtime/tmp/issue-77/models.json` 确认两个本地凭据相关文件均被忽略，提交范围排除既有 `PLAN.md`。
- 审查输入：目标为本节验收与已批准的 core 迁移计划；基线为当前 `HEAD`，变更为工作区的迁移文件及本次 `src/pi/piModelCatalog.ts` / `test/pi/piEngineAdapter.test.ts` / Agent README；证据为上列 RED/GREEN、最终 60/60 测试和真实模型探针。变更尚未提交，`code-review` Skill 的已提交固定点前提不满足；使用主 Agent 对未提交范围作 Standards/Spec 双轴限定审查。
- 审查结论：Standards 轴检查配置引用校验、缺失环境变量不回退为字面量、凭据不传工具及不入日志、禁止命令凭据、私有文件权限；Spec 轴检查 #77 裸 `$ENV_NAME`、原有 `${ENV_NAME}`、真实出站认证匹配及模型非空响应。未发现当前范围的 P0/P1；未获得提供商后台计费对账或真实 Platform 容器执行证据，均不计为本次通过项。回滚方式仍为仅撤销本次模型目录解析、测试和 README 中新增的兼容性说明；core 迁移整体回滚按上方原计划执行。未暂存、未提交，等待用户审批提交信息。
- 后续记录：维护者批准提交信息后，本地提交为 `fe18a7a`（未推送）；GitHub Issue #65 的当前选型已更正，#76 的历史票据增加置顶更正，#77 追加迁移后模型调用的验收边界说明。本节之前“待提交”的文字是提交前的阶段性证据，不代表当前状态。

## 仓库文档选型同步（2026-09-27）

- 状态：文档改动已完成、未提交。范围：当前工程规格、实施计划、任务清单；旧设计交接和 T-05 计划只加历史提示；本记录同步提交状态。非目标：改代码、重写历史票据、改变任务勾选或 GitHub Issue 状态。风险级别 R2（规格/计划与已同步的 Issue 决策一致性）；回滚仅撤销本节六个 Markdown 文件的文案改动，不回滚 `fe18a7a`。
- 实际验证：`git diff --check` 退出码 0；`git grep -n -I -e 'Pi SDK' -e '@earendil-works/pi-coding-agent' -- docs/specs docs/tasks paimeng-ai-code-agent/README.md` 退出码 1（现行规范无旧选型命中）；与 #65 比较的四段现行选型文案一致；`mvp-plan.md` 与 `mvp-todo.md` 的勾选项数量分别保持 102 与 32。仅六个预期 Markdown 有修改，既有 `PLAN.md` 未触碰。纯文档更正，未运行无关构建。
- 审查：以当前 `HEAD` 为基线检查上述六文件的未提交 diff。Standards：文档层级和历史来源可辨，未触及受版本副本规则保护的 `docs/tmp/` 票据；Spec：当前引擎/模型协议/工具边界与 #65 一致，历史交接不再被误当作当前实施指令。P0/P1 未发现；旧票据保留当时的术语作为历史证据。新文案尚未提交或推送。
