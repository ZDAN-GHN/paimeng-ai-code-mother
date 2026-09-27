# T-05 受控 Run 执行（Lease / Sandbox / Run Context）实现计划

> 历史实现计划：Issue #77 已关闭。下文“待评审”、`Pi SDK`/`AgentSession` API 取证与执行清单反映当时的完整 Coding Agent SDK，不是当前 Pi Agent Core 的实施指令。维护者的选型意图仅为薄 Agent 引擎；现行架构见 [工程规格 AD-006](../docs/specs/mvp-engineering-spec.md#ad-006pi-agent-core-通过-agent-engine-adapter-接入)，迁移及验证边界见 [Pi Agent Core 迁移记录](pi-agent-core-migration.md)。旧 SDK 的端到端验收不代表迁移后已复验完整 Platform/Lease/Sandbox 链路。

> 状态：**待评审**。第 0 节四项决策已确认，取证已收口，§7 为可执行清单。
> 对应 Issue：[#77](https://github.com/ZDAN-GHN/paimeng-ai-code-mother/issues/77)
> 上游基线：Issue #77 三条评论（交接说明 → 独立核对 → 补充核对），均为已发布的取证产物。

---

## 0. 维护者决策记录

**第一轮（计划定向）**：

| 决策 | 维护者选择 | 与复审的关系 |
|---|---|---|
| 计划粒度 | **P1–P5 全量详细** | — |
| Docker 交互 | **引入 `docker-java` 依赖** | ⚠️ **否决**复审倾向的 CLI 方案，需按 AGENTS.md 做依赖评估 |
| Lease 时限 | **60s TTL / 20s 续租**（3 次续租机会） | 确认复审自主值 |
| Pi 端到端 | **提供 provider 凭据做一次冒烟** | ⚠️ **提升**复审的验证标准：真实 Session 从「未验证项」变为**必须交付项** |

**第二轮（计划评审反馈）**：

| 决策 | 维护者选择 | 落点 |
|---|---|---|
| 入站服务间鉴权 | **延后**，优先打通核心链路 | §2 缺口段改为延后 + 两条零成本围栏；P3 移除鉴权项 |
| fake Engine 投入 | **压缩**，不在假组件上花时间 | §8 范围从四项压缩为两项（取消 + 一条失败路径） |
| 「零默认工具是否造轮子」 | 提问 | §2 新增成本收益说明：复用 SDK 工具定义，只换 `operations` |
| 「为何不直连 MySQL」 | 提问 | §2 项目规则约束补充 AD-005 / D-06 理由链 |

被改变的后果已并入 §2、§4、§5、§7、§8。

---

## 1. Context

### 目标

补齐 Platform 对 Run 执行权的**权威裁决能力**。当前缺口：`TaskTransitionConditions`
的 `runCreatedAndLeaseGranted` / `runStoppedAndLeaseReleased` 是调用方传入的布尔值，
Platform 自身不持有 Lease 事实，可被调用方欺骗。

### 为什么需要

- **D-06**：Platform Domain 是 Task/Run 状态唯一裁决方；Runtime 只能申请或报告。
- **AD-016**：Platform 受控执行器独占 Docker API；TS Runtime / Pi Adapter / Sandbox
  不得持有 Docker Socket、CLI 凭据或等价宿主机控制权。
- **AD-005**：Runtime 是单 Run 协调器，生命周期短于领域事实；Lease 事实存在 Runtime
  进程内则崩溃后无人能判断写权归属。

### 非目标

Snapshot、Validation、SourceRevision 晋升、Production Deployment（Issue 正文执行边界）。

---

## 2. 已验证的代码现状

### Java（`paimeng-ai-code-backend`）

| 事实 | 位置 | 对计划的影响 |
|---|---|---|
| Run 状态图**已完整** | `platform/domain/PlatformTaskStateMachine.java:65-85` | ⚠️ 与复审评论不符，见 §3 更正 |
| 状态转换已用乐观 CAS | `PlatformRunTransitionService.java:69-77` `updateByQuery(..., eq("state", expectedState))` | 复用该模式，不新建乐观锁字段 |
| `requestId` 已校验非空但无幂等存储 | `PlatformRunTransitionService.java:47` | 幂等需新增存储，不改签名 |
| 审计事件表已 append-only | `V4__platform_integrity_and_audit.sql:41-55` + `uk_platform_run_transition_request(runId, requestId)` | Lease 事件表沿用该形状 |
| 归档活跃判据 | `PlatformApplicationArchiveService.java:21` `ACTIVE_WRITING_RUN_STATES = ["LEASED","EXECUTING"]` | 新增 Lease 后须保持一致 |
| `platform_run` 列 | `id VARCHAR(64)`, `appId`, `taskId`, `state`, `attemptNumber`, `startedTime`, `finishedTime`, `createdTime`, `updatedTime` | — |
| **列名为 camelCase** | `V6__unify_app_root_and_platform_field_names.sql:66-73` | ⚠️ V8 新表必须用 camelCase |
| `platform_run` 有 no-delete 触发器 | `V4:...:platform_run_no_delete` | Lease 表**不得**加该触发器（候选 (a) 需 DELETE） |
| 迁移最新 | `V7__remove_legacy_run_and_credit.sql` | 下一版本号 **V8** |

not found：Lease 实体与表、`ExecutionCapabilities`、Sandbox、幂等键存储、Docker 客户端、
分布式锁、并发测试先例。

#### 实体映射方向（易写反，已核实）

`PlatformRun.java` 的 `@Column` 方向是 **Java 描述性字段名 → DB camelCase 缩写列名**：

```java
@Column("appId")        private Long applicationId;      // DB appId       ← Java applicationId
@Column("startedTime")  private LocalDateTime startedAt; // DB startedTime ← Java startedAt
@Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
private LocalDateTime createdAt;
@Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
private LocalDateTime updatedAt;
```

`onInsertValue`/`onUpdateValue` 用的是 `CURRENT_TIMESTAMP`（不是 `now()`）。`state` 字段无
`@Column`，因为列名与字段名同为 `state`。V8 新实体必须沿用此形状。

#### 入站服务间鉴权：缺口已确认，维护者决定延后

| 事实 | 位置 |
|---|---|
| `AgentJwtService` **只有 `issueToken`，无 verify** | `ai/agent/AgentJwtService.java:20` |
| 该 JWT 是 **Java 签发给浏览器、由 TS Agent 校验**（反方向） | `controller/AppController.java:115` `getAgentToken` → `AgentTokenVO` |
| JWT 载荷 | `sub`(userId) / `appId` / `workspacePath` / `iat` / `exp`，HMAC via hutool `JWT` |
| 密钥与 TTL 配置 | `ts-agent.jwt.secret`、`ts-agent.jwt.ttl-minutes`（`AgentJwtProperties`） |
| **无任何入站鉴权拦截器或过滤器** | 全量 grep `HandlerInterceptor\|OncePerRequest\|WebMvcConfigurer\|Filter` 仅命中 `config/CorsConfig.java` |
| Platform 现有端点鉴权 | 仅 `userService.getLoginUser(request)`（Session/Cookie），无 `@AuthCheck` |

**维护者决策**：安全进度允许滞后，优先打通核心链路，鉴权最后补。P3 **不实现**入站鉴权。

`.agents/rules/api-contracts.md` 要求的「Bearer token 服务认证」在 Java 侧尚无实现载体
（`AgentJwtService` 无 verify，无任何入站拦截器），因此它是新建工作而非复用，延后是合理的
减载取舍。

⚠️ **必须知悉的后果**：受控执行端点在补齐前是**完全无鉴权**的。任何能访问 Java 端口的
进程都可以申请 Lease、在 Sandbox 内执行命令、篡改他人 Application 的 Run 状态。这不是
「安全加固待办」，而是一个开放的远程执行入口。

因此延后附带两条**不可省略的围栏**（成本极低，不构成进度负担）：

- 受控执行端点**只监听回环地址**，或由配置开关默认关闭、仅本地开发显式开启；
  不得随普通部署暴露
- `application.yml` 与端点类各留一条显式 TODO，标注「无鉴权，禁止部署到任何共享或公网环境」

补齐时的实现范围（记入 backlog，不在本次交付）：

- 新增 verify 能力（扩展 `AgentJwtService` 或独立 `PlatformRuntimeTokenService`）
- 受控端点专用的方法级校验或局部 `HandlerInterceptor`；不改动全局链路
- 复用 `ts-agent.jwt.secret`，不引入第二套密钥体系
- 校验须含签名、`exp`、以及 **token 声明的 appId 与请求 runId 所属 Application 一致**

最后一条需单独留意：它不只是鉴权，而是**跨 Application 越权的唯一拦截点**。补齐前，
fence token 只能防「同一 Application 的过期写者」，防不住「另一 Application 的调用方」。

### TS Agent（`paimeng-ai-code-agent`）

| 事实 | 位置 |
|---|---|
| `src/engine/` 为空目录 | T-05 预留 |
| Task 基线 schema v1 就绪（**不得改写**） | `src/protocol/taskExecutionBaseline.ts` |
| 事件归一化就绪 | `src/pi/piEventNormalizer.ts`、`src/protocol/agentExecutionEvent.ts` |
| 协议约定 | zod `.strict()`、`schemaVersion` 字面量、`CURRENT_*_SCHEMA_VERSION` 常量 |
| 测试运行器 | `node:test` + `tsx --test`，目录镜像 `src/` |

not found：Runtime、Run Context、Workspace、`WORKSPACE_ROOT` 读取、Sandbox、
`ExecutionCapabilities`、Execution Policy、Lease、Docker 交互、Java 内部回调客户端。

### Pi SDK API 面（已核实，项目锁定 Pi **0.87.0**）

P4 的工具路由是本任务最容易写错的部分，以下为直接读 `dist/*.d.ts` 得到的事实。

事实来源为**项目自身** `paimeng-ai-code-agent/node_modules/@earendil-works/pi-coding-agent`
（`package.json`、`package-lock.json`、`node_modules` 三者一致锁定 `0.87.0`）。下表每一项均已在
该版本上复核，与开发机全局安装的 `0.87.1` 相关 API 面一致。

| 事实 | 位置 | 对 P4 的约束 |
|---|---|---|
| `noTools?: "all" \| "builtin"` | `dist/core/sdk.d.ts:33` | ⚠️ `"builtin"` 只禁内置工具，**扩展/自定义工具仍启用**；要达到「零默认工具」必须用 `"all"` |
| `tools?: string[]` 允许列表 | `dist/core/sdk.d.ts:43` | 提供时仅启用所列名称 |
| `excludeTools?: string[]` 拒绝列表 | `dist/core/sdk.d.ts:45` | 在 `tools` 之后生效 |
| `customTools?: ToolDefinition[]` | `dist/core/sdk.d.ts:47` | 注册自建工具定义的唯一入口 |
| **`CreateAgentSessionOptions` 无 `toolsOptions` 字段** | 已 grep 确认 not found | ⚠️ **内置工具无法接收 `operations`**；必须自行 `createXToolDefinition(cwd, { operations })` 再经 `customTools` 注册 |
| 8 个可注入工具 | `dist/core/tools/index.d.ts` `ToolName` | `read`/`bash`/`powershell`/`edit`/`write`/`grep`/`find`/`ls`。Linux 下 `powershell` 不适用，但类型面存在 |
| `BashOperations.exec` 形状 | `dist/core/tools/bash.d.ts` | `exec(command, cwd, { onData: (data: Buffer) => void, signal?: AbortSignal, timeout?, env? }) => Promise<{ exitCode: number \| null }>` |
| exec 退出码语义 | 同上（注释） | 信号终止须报 `128 + signal`；`null` 视为失败 |
| 会话 API | `dist/core/agent-session.d.ts:305,417,509` | `subscribe(listener) => () => void`、`prompt(text, options)`、`abort()` |

**P4 工具装配的唯一正确形状**（由上述约束推导）：

```ts
// 1. 自建工具定义并注入容器路由的 operations
const containerBash = createBashToolDefinition(workspaceCwd, {
  operations: containerBashOperations,  // exec 路由进 Sandbox
  exposeSessionEnvironment: false,      // 不泄漏宿主机 PI_* 环境
})
// read/write/edit/grep/find/ls 同理

// 2. 零默认工具 + 仅注册自建工具
await createAgentSession({
  cwd: workspaceCwd,
  noTools: 'all',                  // 必须 'all'，不可用 'builtin'
  customTools: [containerBash, ...],
  tools: [/* 显式白名单 */],
})
```

`AC-008` 的保证**不得**依赖「Pi 只会调用注入的 operations」这一假设——必须由 `noTools: 'all'`
确保无任何工具走默认本地实现。官方文档 `docs/containerization.md:183` 亦独立给出同向警告：
未显式委派 operations 的工具会落在隔离边界外。

#### 这不是造轮子：`noTools: 'all'` 的实际成本与收益

维护者的顾虑合理——文件读写这类能力 SDK 原生就有，不该重写。**本方案确实没有重写。**

SDK 导出了工具定义的工厂函数（`dist/core/tools/*.d.ts`）：

```
createBashToolDefinition(cwd, options?)   // dist/core/tools/bash.d.ts:85
createReadToolDefinition(cwd, options?)   // dist/core/tools/read.d.ts:39
createWriteToolDefinition(cwd, options?)  // dist/core/tools/write.d.ts:27
```

我们调用这些工厂拿到 SDK 自带的工具定义——**schema、提示词、参数解析、结果渲染全部复用**，
只替换 `options.operations` 一个字段，把「在哪执行」从宿主机改为容器。工具的行为逻辑不是我们写的。

那为什么必须 `'all'` 而不是 `'builtin'`？看类型定义原文（`dist/core/sdk.d.ts:29-31`）：

```
 * - "all": start with no tools enabled
 * - "builtin": disable the default built-in tools (read, bash, edit, write)
 *   but keep extension/custom tools enabled
```

`'builtin'` 只关掉 read/bash/edit/write 四个，**扩展工具仍然启用**。宿主机上被发现的任何
扩展工具会继续以其原生本地实现运行，直接绕过 Sandbox——而我们无法穷举宿主机上会被发现什么。

所以两者的差别不是「造多少轮子」（都是零），而是：

| | 复用 SDK 工具定义 | 隔离边界 |
|---|---|---|
| `'builtin'` + customTools | ✅ 复用 | ❌ 扩展工具漏在边界外 |
| `'all'` + customTools | ✅ 同样复用 | ✅ 白名单外无工具可执行 |

`'all'` 的额外成本是**一个字符串字面量**，收益是消除「某个未预期的工具静默落在隔离边界外」
这一整类漏洞。AD-016 要求 Sandbox 不得持有等价宿主机控制权，这条边界不能建立在
「宿主机上恰好没装危险扩展」的假设上。

### 项目规则约束

- `.agents/rules/database.md`：新表新字段**小驼峰**；TS Agent **不直连 MySQL**，业务数据经
  Java 回调 → 印证 Runtime→Platform 为 HTTP 边界。

  **该规则的理由**（`database.md:15` 只写规则未写原因，理由在别处）：
  - `mvp-engineering-spec.md:433` AD-005 背景原文：「将领域状态放入 Runtime 或 Pi 会使**恢复、
    替换和审计不可靠**」。Runtime 是单 Run 协调器，**生命周期短于领域事实**（AD-005 决定项）；
    若它直连写库，进程崩溃后没有任何组件能裁决那些写入是否有效、属于哪个 Run。
  - `project-boundaries.md` 把「不暴露数据库给 Node」列为 **Java 后端的禁区**，与 TS Agent
    的「不直连 MySQL」互为一体两面。
  - D-06 规定 Platform 是 Task/Run 状态的**唯一裁决方**。两个写入者就没有唯一裁决方——
    这正是本 Issue 要修的同一类问题（Lease 事实不能由调用方自报）。

  即：不直连不是代码洁癖，是 D-06 单一裁决方成立的必要条件。同一条理由也解释了为什么
  Lease 事实必须落 Platform 而非 Runtime 进程内。
- `.agents/rules/api-contracts.md`：Agent 内部调用用 **Bearer token 服务认证 + runId 幂等**；
  跨服务调用设计变更前须经 `grilling`（Issue #77 三条评论已履行）。
- `.agents/rules/testing.md`：覆盖成功路径 / 主要失败路径 / 权限边界；跨域集成测试与
  fixtures 放测试树顶层。
- `.agents/rules/errors.md`：跨服务调用须设明确超时、快速失败；禁止无上限重试与吞错。

---

## 3. 对上游评论的一处更正

复审评论将「含 `executing → succeeded` 边」列入 P1 待实现项。**该边已存在**：

```java
// PlatformTaskStateMachine.java:79-82
case EXECUTING ->
    target == PlatformRunState.SUCCEEDED ||
    target == PlatformRunState.FAILED ||
    target == PlatformRunState.CANCELLED;
```

`CREATED → LEASED`、`CREATED → FAILED`、`LEASED → {EXECUTING, FAILED, CANCELLED}` 亦均已存在。

因此 P1 的 Run 状态机工作**不是新增边**，而是：让转换消费**真实 Lease 事实**替代调用方布尔值。
这缩小了 P1 的 diff，但不改变 P1 的必要性。

---

## 4. Approach

### 分片（沿用复审的 P1–P5）

| 片 | 内容 | 独立验证边界 |
|---|---|---|
| P1 | Java Lease 领域 + Flyway V8 + Run 状态机接线 | 真实 MySQL `@SpringBootTest` |
| P2 | Java Docker Sandbox 执行器 + 模板镜像 | 容器 inspect 断言 |
| P3 | Java 受控执行 API + `ExecutionCapabilities` v1（鉴权延后） | Controller 测试 + **确定性交错** |
| P4 | TS Runtime + `AgentEngineAdapter` + Pi 实现 + Tool Contract | fake Engine |
| P5 | 跨服务与隔离集成验证收口（含 **AC-3 整体**） | `./mvnw verify` + TS 三命令 |

### 已锁定的实现决策（来自复审，已核实正当）

- **Lease 唯一性**：活跃 Lease 单行表 + `UNIQUE(appId)`；释放即 DELETE；历史证据落独立
  append-only Lease 事件表。物理删除不丢证据，因证据载体在事件表。
- **fencing token**：Application 级单调递增 `BIGINT`，每次授予自增。
- **幂等键作用域**：按 `(runId, operation)`，与既有 `uk_platform_run_transition_request` 粒度一致。
- **`ExecutionCapabilities` 事实来源**：**Java 侧**（P3）。AD-016 规定只有 Platform 受控执行器
  掌握隔离后端真实能力；Runtime 组装 Run Context 但不得自报无权验证的隔离属性。
- **兼容矩阵**：schema version 精确匹配即兼容，不做字段级协商（MVP 仅 v1）。
- **Pi 工具路由**：`noTools` + 显式 `tools` 白名单 + `operations` 注入路由进容器。
  **不得**依赖「Pi 只会调用注入的 operations」假设。
- **Gondolin 已排除**：QEMU micro-VM 示例扩展，由 TS 侧控制 VM 生命周期 = AD-016 禁止的
  等价宿主机控制权；且凭据继承宿主机环境变量。但其存在印证了 host-Pi + 工具路由是官方形状，
  可作参考实现阅读。

### docker-java 依赖评估（AGENTS.md 要求，已完成）

维护者否决 CLI 方案、选定引入 `docker-java`。按依赖引入规范核实如下：

| 项 | 结论 | 来源 |
|---|---|---|
| 锁定版本 | **3.7.1**（2026-03-18 发布） | Maven Central `maven-metadata.xml` `<release>`；GitHub Release tag |
| 许可证 | Apache-2.0 | repo LICENSE |
| 维护状态 | 活跃，最近 push 2026-09-21 | GitHub |
| 自身 CVE | **无**（OSV.dev 与 GitHub Advisory 均 0 条） | OSV.dev / GHSA API |
| 破坏性变更 | 3.7.1 仅 `ListImagesCmd#withImageNameFilter` 标记 deprecated | Release note |

Maven Central 的 Solr 搜索索引滞后显示 3.5.1 为最新，**以 `maven-metadata.xml` 为准**。

#### Transport 选择：`docker-java-transport-httpclient5`（不是 netty）

| Transport | 传递依赖 | 与 Spring Boot 3.5.0 BOM 的关系 |
|---|---|---|
| `httpclient5` ✅ | httpclient5 `5.5.1` + jna `5.18.1` | 无大版本冲突 |
| `netty` ❌ | netty **4.2.10.Final** | BOM 为 **4.1.121.Final**，跨大版本线，与 reactor-netty 真实冲突 |

netty 4.2.10 另落在多个 2026 年 netty-handler CVE 受影响区间（GHSA-3qp7 / c4c3 / c653 /
x4gw / fccg，均在 4.2.15+ 修复）。虽为 TLS SNI 相关、本场景走 unix socket 影响面小，
但叠加版本冲突后无理由选它。

**必须在 `dependencyManagement` 显式统一 jackson**：docker-java-core 传递 jackson-databind
`2.20.1`，Spring Boot 3.5.0 BOM 为 `2.19.0`。同属 2.x 理论兼容，但须避免类路径混版
jackson-core/databind。slf4j-api 传递版本为 `1.7.30`（偏旧），Spring Boot 3.x 走 slf4j 2.x，
通常可兼容加载，仍建议显式对齐以消除告警。

#### 未经工具验证的一项

**docker-java 3.7.1 对 Docker Engine 29.x 的兼容性未能静态确认**（`RemoteApiVersion.java`
源码抓取失败）。Docker Engine API 有版本协商机制，历史上 docker-java 对新 Engine 保持向后兼容。
P2 第一步必须实测 `dockerClient.versionCmd().exec()` 确认协商结果，不以静态推断代替。

#### exec 流式 API 形状（已核实源码，tag 3.7.1）

```java
ExecCreateCmdResponse created = dockerClient.execCreateCmd(containerId)
    .withAttachStdin(true).withAttachStdout(true).withAttachStderr(true)
    .withCmd("sh", "-c", command)
    .exec();

dockerClient.execStartCmd(created.getId())
    .withStdIn(pipedInputStream)                    // 阻塞 InputStream 提供节流
    .exec(new ResultCallback.Adapter<Frame>() {
        @Override public void onNext(Frame frame) { /* chunk → onData */ }
    });
```

`ExecStartCmd extends AsyncDockerCmd<ExecStartCmd, Frame>`：**回调式，非 Reactive Streams**，
无原生响应式背压 API；背压靠阻塞 `InputStream` 读取实现。这与 P4 `BashOperations.exec` 的
`onData: (data: Buffer) => void` 回调形状同构，桥接无语义落差。

---

## 5. Files to modify

### P1

- 新增 `paimeng-ai-code-backend/src/main/resources/db/migration/V8__platform_run_lease.sql`
- 新增 `platform/entity/PlatformRunLease.java`、`PlatformRunLeaseEvent.java`
- 新增 `mapper/platform/PlatformRunLeaseMapper.java`、`PlatformRunLeaseEventMapper.java`
- 新增 `platform/domain/PlatformRunLeaseService.java`
- 修改 `platform/domain/PlatformRunTransitionService.java`（消费真实 Lease 事实）
- 修改 `platform/domain/TaskTransitionConditions.java` 或其构造路径
- 核对 `platform/domain/PlatformApplicationArchiveService.java`（判据一致性）

### P2

- 修改 `paimeng-ai-code-backend/pom.xml`（docker-java 3.7.1 + httpclient5 transport +
  jackson/slf4j 版本统一 + 排除 netty transport）
- 新增 `platform/sandbox/PlatformSandboxExecutor.java` 及其配置类
- 新增 `infra/docker/` 下的 Sandbox 模板镜像 Dockerfile

### P3

- 新增 `platform/controller/PlatformRunExecutionController.java`（受控执行 API）
- 新增 `platform/dto/` 与 `platform/vo/` 下的受控执行请求与 `ExecutionCapabilities` VO
- 修改 `src/main/resources/application.yml`（受控端点回环绑定 / 默认关闭开关 + 无鉴权 TODO）

入站鉴权组件按维护者决策延后，不在本次交付（见 §2）。

### P4

- 新增 `paimeng-ai-code-agent/src/protocol/runContext.ts`、`executionCapabilities.ts`
- 新增 `paimeng-ai-code-agent/src/engine/`（Runtime、`AgentEngineAdapter` 接口与 Pi 实现、
  Tool Contract、Java 回调客户端）
- 测试镜像目录 `paimeng-ai-code-agent/test/engine/`、`test/protocol/`

---

## 6. Reuse

| 复用对象 | 位置 | 用途 |
|---|---|---|
| 乐观 CAS 转换模式 | `PlatformRunTransitionService.java:69-77` | Lease 状态变更沿用 |
| append-only 事件表形状 | `V4__platform_integrity_and_audit.sql:41-55` | Lease 事件表 |
| `PlatformLogicalRelationValidator` | `platform/domain/` | Lease 操作的归属校验 |
| `BusinessException` + `ErrorCode` | `exception/` | 拒绝语义 |
| 跨服务夹具目录 | `src/test/resources/contracts/task-execution-baseline/v1-initial-application.json` | Run Context 夹具沿用 |
| Flyway 校验测试 | `PlatformMigrationTest` | V8 迁移校验 |
| 完整性集成测试 | `PlatformIntegrityIntegrationTest` | Lease 集成测试参照 |
| zod schema 约定 | `src/protocol/taskExecutionBaseline.ts` | 新协议类型沿用 `.strict()` + `schemaVersion` |
| 事件归一化 | `src/pi/piEventNormalizer.ts` | P4 Adapter 直接复用 |

---

## 7. Steps

片间串行（P1 → P2 → P3 → P4 → P5）。P1/P2 无依赖可并行起步，但 P3 依赖两者，P4 依赖 P3 的
契约定稿。每片自带验证，未通过不进入下一片。

### P1 — Java Lease 领域 + V8 迁移 + 状态机接线

- [x] 写 `V8__platform_run_lease.sql`：`platform_run_lease`（活跃单行，`UNIQUE(appId)`，
      **不加** no-delete 触发器）+ `platform_run_lease_event`（append-only，沿用 V4 形状 +
      `UNIQUE(runId, requestId)`）。列名全部 **camelCase**
- [x] `platform_run_lease` 字段：`id`/`appId`/`runId`/`taskId`/`fenceToken BIGINT`/
      `leaseState`/`grantedTime`/`expiresTime`/`renewCount`/`createdTime`/`updatedTime`
- [x] Application 级 fence 计数器：新增列或独立表，授予时单调自增（同事务内取值）
- [x] 新增 `PlatformRunLease.java` / `PlatformRunLeaseEvent.java`，`@Column` 方向与
      `PlatformRun` 一致（Java 描述名 → DB camelCase），时间戳用 `CURRENT_TIMESTAMP`
- [x] 新增两个空 `BaseMapper` 接口（置于 `mapper.platform`，已被 `@MapperScan` 覆盖）
- [x] 新增 `PlatformRunLeaseService`：`grant` / `renew` / `release` / `expire`，
      `@Transactional(rollbackFor = Exception.class)`，每个操作写事件表
- [x] TTL 常量：**60s TTL / 20s 续租间隔 / 最多 3 次续租**（维护者决策）
- [x] 幂等：`(runId, operation)` 作用域，重放返回首次结果而非报错
- [x] 改 `PlatformRunTransitionService`：`runCreatedAndLeaseGranted` /
      `runStoppedAndLeaseReleased` 改为**查询真实 Lease 行**，不再接受调用方布尔值
- [x] 同步改 `TaskTransitionConditions` 的构造路径，移除被欺骗的入参
- [x] 核对 `PlatformApplicationArchiveService.ACTIVE_WRITING_RUN_STATES` 与新 Lease 判据一致
- [x] 验证：`PlatformMigrationTest` 断言 V8 元素；新增 `PlatformRunLeaseIntegrationTest`
      覆盖唯一性拒绝、续租上限、释放、过期、取消、事件 append-only

### P2 — Docker Sandbox 执行器 + 模板镜像

- [x] `pom.xml` 加 `docker-java` **3.7.1** + `docker-java-transport-httpclient5`；
      `dependencyManagement` 显式统一 jackson 与 slf4j；**排除 netty transport**
- [x] **第一步实测** `dockerClient.versionCmd().exec()`，确认与本机 Docker Engine 的协商版本
      （静态未验证项，见 §4）
- [x] 模板镜像 Dockerfile（生成应用目标栈：Node 24.20.0）置于 `infra/docker/`
- [x] `PlatformSandboxExecutor`：创建容器时设资源限额、`--network none`（或受限网络）、
      **不挂载 Docker Socket**、**不做任何宿主机挂载**；Workspace 为容器内 tmpfs
      （AD-016 禁止宿主机目录挂载，见下方订正）
- [x] exec 流式桥接：`execCreateCmd` + `execStartCmd` 回调 → chunk 输出；`withStdIn`
      阻塞流实现背压
- [x] 退出码语义：信号终止报 `128 + signal`；`null` 视为失败
- [x] 生命周期：10 秒优雅停止（SIGTERM → 超时 SIGKILL）+ 容器与卷清理，失败路径也清理
- [x] 验证：容器 inspect 断言限额 / 零 bind mount / Workspace 为 tmpfs 且对容器身份可写 /
      无外网；停止与清理用例

> **订正（实施中发现，维护者已裁定立即改造）**：本片初稿把 Workspace 写成宿主机
> bind mount，且默认根指向 `AppConstant.CODE_OUTPUT_ROOT_DIR`——该目录树正由
> `StaticResourceController` 对外提供 HTTP 访问，Sandbox 写出的内容会落进可被访问的目录。
> AD-016（`Locked Decision`）规定 Workspace 为容器内 tmpfs 且禁止宿主机目录挂载，
> 已按 AD-016 改造：`start(...)` 不再接收宿主机路径，`PlatformSandboxHandle` 不再含
> `workspacePath`，tmpfs 挂载选项的 `uid`/`gid` 与镜像 `USER node` 同源。
> 后果：Workspace 随容器删除而消失，需留存的事实由 Platform 在受信任边界提取（T-06 范围）。

### P3 — 受控执行 API + `ExecutionCapabilities` v1

入站鉴权按维护者决策延后（见 §2）。本片只做核心链路 + 两条零成本围栏。

- [x] 受控执行端点**绑定回环**或由配置开关默认关闭，仅本地开发显式开启
- [x] `application.yml` 与端点类各留显式 TODO：「无鉴权，禁止部署到共享或公网环境」
- [x] `PlatformRunExecutionController`：Lease 申请 / 续租 / 释放 / 执行命令 / 上报结果；
      `BaseResponse<T>` + `ResultUtils.success`，异常经 `GlobalExceptionHandler`
- [x] 每个写操作校验 fence token；fence 落后即拒绝并写审计原因
- [x] **请求的 runId 必须归属其声明的 appId**——复用 `PlatformLogicalRelationValidator`
      做归属校验。鉴权延后期间这是唯一的跨 Application 拦截点，不可省略
- [x] `ExecutionCapabilities` v1 **由 Java 侧**组装并返回（AD-016：只有 Platform 掌握隔离
      后端真实能力）；`schemaVersion` 精确匹配即兼容
- [x] VO 中 Long ID 以十进制字符串传输（沿用 `PlatformApplicationVO` 约定）
- [x] 超时与快速失败：按 `.agents/rules/errors.md`，禁止无上限重试与吞错
- [x] 验证：`MockMvc` standaloneSetup + `GlobalExceptionHandler` 的控制器测试；
      边界用例（fence 落后 / runId 与 appId 不匹配 / Lease 不存在）；
      **确定性交错用例**——测试钩子在 fence 校验后、使用前释放 Lease，断言被拒且留审计

### P4 — TS Runtime + `AgentEngineAdapter` + Pi 实现 + Tool Contract

- [x] `src/protocol/runContext.ts`、`src/protocol/executionCapabilities.ts`：zod `.strict()` +
      `schemaVersion` 字面量 + `CURRENT_*_SCHEMA_VERSION` 常量
- [x] `src/engine/` 下的 Runtime：单 Run 协调器，生命周期短于领域事实（AD-005）；
      Lease 事实**不落进程内**，每次操作携 fence token 问 Platform
- [x] Java 回调客户端：Bearer token + `runId` 幂等键（`.agents/rules/api-contracts.md`）
      —— 鉴权延后期间 Bearer 头可留占位，`runId` 幂等键**照常实现**（它是正确性而非安全机制）
- [x] `AgentEngineAdapter` 接口 + Pi 实现；工具装配严格按 §2 的唯一正确形状：
      `noTools: 'all'`（**不是 `'builtin'`**）+ `customTools` 注册自建定义 + 显式 `tools` 白名单
- [x] 每个工具的 `operations` 路由进 Sandbox；`exposeSessionEnvironment: false`
- [x] 复用 `src/pi/piEventNormalizer.ts` 做事件归一化；**不得改写**
      `src/protocol/taskExecutionBaseline.ts`
- [x] 取消：`session.abort()` + Sandbox 停止 + Lease 释放，三者顺序与失败补偿明确
- [x] 验证：**最小 fake Engine**（按 `AgentEngineAdapter` 接口打桩、可脚本化产出事件序列，
      不模拟 Pi 内部行为）。只覆盖取消与一条失败路径——这两条真实 Engine 难以稳定触发；
      背压与事件顺序改由 P5 真实冒烟观察。测试目录镜像 `src/`

### P5 — 跨服务与隔离集成验证收口

- [x] AC-3 四项合取条件的真实容器验证
- [x] Sandbox 越界集成测试：文件越界、网络外连、凭据读取均被拒
- [x] **真实 Pi Session 端到端冒烟**（维护者提供 provider 凭据，已提升为必须交付项）
- [x] 收口：`./mvnw verify` + `npm run type-check && npm run test && npm run build`
- [x] 交付记录：按闭环任务协议记录证据；逐项更新 Issue #77 验收复选框

---

## 8. Verification

- Java：`cd paimeng-ai-code-backend && ./mvnw -Dtest=ClassNameTest test`；收口 `./mvnw verify`
- TS Agent：`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build`
- 基础设施静态检查：`docker compose config`
- 本地依赖：`docker compose up -d`（MySQL 8.0.46）

### 必须的专项验证

- **P1**：Lease 唯一性拒绝（单线程两次插入即可，唯一约束兜底）、续租、释放、过期、取消、
  审计 append-only
- **P3**：**确定性交错**用例——测试钩子在 fence 校验后、使用前释放 Lease，断言请求被拒绝并留
  审计原因（补 TOCTOU 覆盖，非多线程基建）；以及 runId/appId 归属校验用例（鉴权延后期间的
  唯一跨 Application 拦截点）
- **P2**：容器 inspect 断言资源限额 / 零 bind mount（覆盖「无 Docker Socket」与「无宿主机挂载」）/
  Workspace 为 tmpfs 且对容器身份可写 / 无外网；10 秒优雅停止与清理
- **P5**：AC-3 四项合取条件的真实容器验证；Sandbox 越界文件 / 网络 / 凭据集成测试

### 真实 Pi Session 端到端（维护者已提升为必须交付项）

复审原本把它列为「已知无法验证」（本机无 provider 凭据）。维护者决定**提供凭据做一次冒烟**，
因此它从未验证项变为 P5 的交付门槛：

- 凭据只经**被忽略的 `.env`** 注入，不写入代码、配置或提交；不回显到日志与交付记录
- 冒烟范围：一次真实 Session 走通「Lease 授予 → 容器内工具调用 → 事件归一化 → 结果上报 →
  Lease 释放」，断言工具调用**确实发生在容器内**。Workspace 改为容器内 tmpfs 后，
  判据不再是「宿主机 workspace 无越界写入痕迹」，而是：容器内 `/workspace` 出现预期产物，
  且宿主机文件系统全程无对应写入（零 bind mount 使其无路径可写）

### fake Engine 的范围已按维护者要求压缩

维护者要求不在「假」组件上投入过多时间。原计划让 fake Engine 覆盖取消、背压、事件顺序、
失败路径四项，现压缩为**两项**：

| 项 | 归属 | 理由 |
|---|---|---|
| 取消 | fake Engine | 真实 Session 难以在确定时点触发中断 |
| 一条失败路径 | fake Engine | 同上；且失败路径是 `.agents/rules/testing.md` 要求的覆盖项 |
| 背压 | **移交 P5 真实冒烟观察** | 真实输出流即可体现，无需伪造 |
| 事件顺序 | **移交 P5 真实冒烟观察** | 同上 |

fake Engine 只按 `AgentEngineAdapter` 接口打桩、脚本化产出事件序列，**不模拟 Pi 内部行为**。

取消与失败路径不能也移交冒烟：它们无法靠一次正向通路观察到，而 Sandbox 泄漏（取消后容器
残留）与 Lease 泄漏（失败后未释放）都会阻塞后续 Run。这两项是压缩后的下限，不是可选项。

### 仍然无法在本机验证

docker-java 3.7.1 与 Docker Engine 的 API 协商结果需实测取得（P2 第一步），在此之前不写入
任何依赖具体 Engine API 版本的断言。

---

## 9. 环境事实

| 项 | 值 | 来源 |
|---|---|---|
| MySQL | 8.0.46 | `docker-compose.yml:7` |
| Java | 21 + Maven Wrapper | `AGENTS.md` |
| Node（Agent 运行时） | >= 20 | `AGENTS.md` |
| Pi（项目锁定） | **0.87.0** | `paimeng-ai-code-agent/package.json` + `package-lock.json` + `node_modules` 三者一致 |
| Node（Agent `engines`） | `24.20.0`（精确） | `paimeng-ai-code-agent/package.json` |
| Fastify（Agent 自身） | `5.12.3` | 同上 |
| zod | `4.6.5` | 同上 |
| TypeScript / tsx | `5.9.3` / `4.23.15` | 同上（devDependencies） |
| 生成应用目标栈 | Node 24.20.0 / Vue 3.5.17 / Vite 7.0.4 / Fastify 5.12.3 / Prisma 7.10.0 / MySQL 8 | AD-014 |

### 我先前发布到 Issue #77 的一处版本错误

补充核对评论（`#issuecomment-5810028497`）第 4 节称「上一条评论记作 Pi `0.87.0`；本机实际安装为
`0.87.1`」。**该更正错误**：`0.87.1` 是我开发机的**全局** Pi 安装，与本项目无关。项目锁定
`0.87.0`，复审评论原本正确。

已在本计划中修正。实现者**不需要**升级 Pi 版本；相关 API 面已在 `0.87.0` 上复核通过。
此错误需在 Issue 上更正，避免实现者按错误事实行动。

---

## 10. 执行与交付证据（2026-09-26）

- 状态：`delivered`（AC-3 实现、真实容器验证、独立审查 P1 修复与复验已收口；Issue 待维护者关闭）。目标是完成 Issue #77 的受控执行、真实 Pi 链路和重启接管；非目标仍是
  Snapshot、Validation、SourceRevision 晋升与 Production Deployment。风险级别 `R3`：
  Sandbox 隔离、凭据和持久 Run/Lease 状态均受影响。
- Java：`cd paimeng-ai-code-backend && ./mvnw verify` 退出 0；114 项测试通过。
  `PlatformSandboxExecutorIntegrationTest` 的 10 项真实容器用例执行、0 跳过，涵盖
  资源限额、tmpfs、零宿主机挂载、网络外连、宿主凭据与跨 Run 工作区隔离。
- Agent：`cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build`
  均退出 0；40 项测试通过。凭据只经被忽略且权限为 `600` 的 `.env` 加载；
  自定义模型目录由 Adapter 显式传入，不自动加载宿主资源。bash 工具环境泄漏回归
  测试先失败后通过，阻断宿主环境变量进入容器。
- 真实 Pi：`xhy-api/gpt-6-luna` 的最小 SDK 请求返回 `stop` 且有非空文本。
  首个合成 Run 在首次工具调用前失败并清理 Lease/容器；后续独立无工具诊断曾收到
  HTTP 503，不能反推首个 Run 的确切 HTTP 状态。网关恢复后，新合成 Run
  `run-issue77-467cd2cd-588e-49c5-aec7-1641597b24d4` 完成：归一化事件依次包含
  `execution.started`、`write` 与 `bash` 的开始/完成，容器内产物内容校验通过；
  DB 状态 `CREATED→LEASED→EXECUTING→SUCCEEDED`，Lease 事件 GRANTED/RELEASED 各 1，
  活跃 Lease 0、残留容器 0、宿主机对应文件不存在。测试服务已停止，8123 端口关闭。
- 初次审查（AC-3 实现前，未提交工作区的双轴定界审查）：Standards 侧检查工具仅走 Platform、
  不继承 Runtime 环境、回环端点与资源回收，未发现新的未处置 P0；Spec 侧
  AC-3 为未处置 P1：`grantLease` 对所有非 `CREATED` Run 拒绝，同一 Run 无正向重启接管；
  `/commands` 无持久幂等执行结果，Pi 外部请求也无可确认的在途状态。
  仅拒绝不安全接管不能证明四项合取条件下可接管。当时步骤 38 未完成；现已按下方证据修复并实测，
  后续独立审查与修复结论见下方；Issue 暂保持开放。
- 回滚与残留：仅回退本任务范围代码与配置；两组本地合成 App/Task/Run 及 append-only
  审计记录保留，不擅自删除。测试密钥不入记录，维护者在测试结束后轮换临时密钥。

### AC-3 正向接管的确认边界（维护者选择 A，2026-09-26）

- 仅在同一 Run 已 `LEASED`、旧 Lease 不再有效、原容器仍运行且其 tmpfs Workspace 为空、
  Platform 持久检查点证明**尚无模型或命令请求发出**时，以新 fence 接管并重建 Pi Session。
- 首个模型请求发出前，Runtime 必须取得 Platform 的持久准入；一旦准入完成，
  不再自动接管该 Run。请求在途、工作区非空、容器丢失、历史 Run 无检查点均拒绝。
- 新增 V9 加法式检查点与命令请求幂等记录；旧 Runtime 不参与检查点协议，
  其历史 `LEASED` Run 不视作安全接管候选。维护者已明确选择此范围并授权本地测试库迁移。
- 不将此范围描述为「执行到一半的 Pi 对话续跑」。一般执行中恢复依赖后续的
  Snapshot/会话及外部请求完成证据，在本次验收中不是可承诺的能力。

### AC-3 实测补证（2026-09-26）

- V9 在本地 MySQL 迁移成功。`PlatformRunRecoveryIntegrationTest` 六项真实容器测试
  0 跳过，包含过期 Lease 原容器正向接管、旧 fence 拒绝、模型请求开始/工作区变更/
  容器丢失/历史 Run/旧版 Runtime 拒绝，以及持久命令键重复执行拒绝；相关定向测试共
  35 项通过。仅 `PREPARED` 且外部请求为零的 Run 有正向接管窗口。
- 最终 Agent 类型检查、43 项测试（0 跳过）和构建通过。Java 完整 `./mvnw verify`
  首次 122 项中的旧网页截图测试因 Chrome renderer 30 秒超时失败；停止并行构建后
  隔离重跑 122 项通过、0 跳过、构建成功。两次结果均保留，不将首次失败隐去。
- 两个独立 Node 进程模拟 Runtime 重启：首进程建立检查点，旧 Lease 到期；新进程以
  同一 Run `run-issue77-e0fad17a-3dc2-4017-8d0c-67073d070e26` 和原 Sandbox
  `fa609c1c84a8a0...` 取得 fence 2。真实 Pi `write`、`bash` 均成功且事件顺序正确，
  预期产物只在原容器 `/workspace` 检出。DB 为 `SUCCEEDED`、Lease
  `GRANTED(1)→EXPIRED(1)→GRANTED(2)→RELEASED(2)`、活跃 Lease 0、4 条
  命令记录 `COMPLETED`；无残留 Sandbox，8123 服务端口已关闭。
- 本地合成数据与 append-only 事件保留，不能通过删除它们来伪装验证通过。二进制回滚
  不删除 V9 新表；旧代码不依赖该表，生产数据迁移与发布不在本次授权范围。

### 最终交付审查及修复（2026-09-26）

- 范围：Issue #77 和当前未提交工作区变更；风险 `R3`。独立只读审查指出 P1：
  `PlatformRunRecoveryService.startCommand` 在恢复检查点不存在时允许命令进入 Sandbox。
  真实容器回归先失败（预期 `BusinessException`，实际未抛出），改为检查点缺失或
  非 `STARTED` 一律拒绝后，同一正向接管用例通过；没有记录命令副作用。
- 契约审查指出基线 v1 原有 `baseProfileVersion` 为数字，而 Java 非空 `Long` 输出为
  字符串；本次曾尝试将 TS 基线改为字符串，违反 Issue「不能改写 Task 基线 schema」
  的冻结约束，已恢复原 schema，相关文件与 HEAD 无差异。非空 profile 的跨服务
  线协议仍需由基线所有者单独确定；本次 Runtime 明确拒绝这类不兼容组合，不承诺支持。
- 独立审查其余非阻断项：Run Context 的归一化 capabilities 二次校验可合并，
  `reportResult` 失败的本地失败码可更精确；当前跨服务验证为夹具、服务接口与真实 Pi
  冒烟，不宣称已接入浏览器生成入口。这些未改变本次受控 Runtime 边界。
- 修复后 `cd paimeng-ai-code-backend && ./mvnw verify` 退出 0，122 项、0 跳过；
  `cd paimeng-ai-code-agent && npm run type-check && npm run test && npm run build`
  退出 0，42 项、0 跳过。`git diff --check` 通过；8123 无监听，
  `com.zdan.paimeng.platform.sandbox.managed-by=platform-sandbox-executor` 标签容器数量为 0。
  前述隔离并发时网页截图超时的失败仍保留于初次验证记录，最终串行复验成功。
- 审查结论：P1 已修复并在真实容器中复验，未观察到剩余 P0/P1；上述非空基线协议
  不在 #77 的已授权兼容范围。代码、容器模板或配置的回滚仅针对本任务范围，V8/V9
  加法表及审计历史保留；未提交、未推送、未部署，也未关闭 Issue。
