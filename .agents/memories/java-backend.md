# 记忆：Java 后端

> Java Spring Boot 侧的工作记忆。目标架构中 Java 的职责与边界见 `docs/ts_agent/architecture.md`；历史契约细节见 `docs/py_agent/task_plan.md` §1.6/§7 与 `AGENTS.md`。

## 当前状态（2026-09-03 退役决策后核对）

| 项 | 状态 |
|---|---|
| `./mvnw compile` | **通过**（需 JDK 21；本机 sdkman 已装 `21.0.12+1.1-tem`，当前 JDK 17 会报 `release version 21 not supported`） |
| `ai/agent/`（原 `ai/python/`，**#6 已泛化**） | `AgentProperties`/`AgentClient`/`AgentSseAdapter`/`AgentRequest`/`AgentCallbackRequest`/`RunIdSinkRegistry`（`agent.*` 配置段，`python-agent.*` 为别名） |
| `AppServiceImpl` | T18 已含 `agent.enabled` 分支（开关变量由 `pythonAgentProperties` 改名 `agentProperties`，语义等价）；本地 `application-local.yml` 已回切 `enabled: false`（**P0 已执行 2026-09-03**，旧 Java AI 为过渡主链路） |
| `application.yml` `python-agent` 段 | 保留作旧别名（expand-contract）：`enabled/base-url/token/connect-timeout-ms/read-timeout-ms/callback-timeout-ms`；`AgentLegacyAliasPostProcessor` 自动复制到 `agent.*`（新键显式设置时不覆盖） |
| 旧 AI 链路 `ai/` + `langgraph4j/` | 完整存在（**过渡期主链路**；TS Agent 契约对等后按 `docs/py_agent/t21_delete_plan.md` 删除，门禁已重定向） |

## 2026-09-03 架构定稿中对 Java 的新增职责

- **签发短时 JWT**（前端 fetch-SSE 直连 TS Agent 用，Agent 离线验签，不回查 Java）。
- **积分体系**：预冻结 → 结算 → 退款，挂 runId 幂等（复用 `RunIdSinkRegistry` 机制）；按次 + 档位系数计费；MVP 后台手动充值。
- **Agent→Java 内部回调**沿用 `/api/app/chat/gen/code/callback`（Bearer + runId 幂等）：结算积分 / 写历史 / 触发构建。

## 2026-09-04 generation_run 内部 API（Issue #4 已落地）

- **表**：`sql/create_table.sql` 新增 `generation_run`（run_id varchar PK 复用 runId 语义、appId/userId、phase 显式 MySQL ENUM 九值、context/milestones/tokenUsage JSON、creditLedgerRef 预留、startedTime/finishedTime）；索引 idx_appId_phase / idx_userId。**列名按项目既有约定用 camelCase**（user/app/chat_history 均为 camelCase；架构文档 §3.2 的 snake_case 为设计层命名，实现落 camelCase 并在此记录）。
- **端点**（`GenerationRunController`，`/api/internal/*`，Bearer 服务令牌，配置 `internal-api.token`/`INTERNAL_API_TOKEN`）：
  - `POST /internal/runs` 创建（同 runId 幂等返回既有；同 app 非终态并发 → **409**「当前有进行中的任务」）
  - `PATCH /internal/runs/{runId}` 推进 phase/context/milestones/tokenUsage（无变化不落库；进终态自动补 finished_time）
  - `GET /internal/runs/{runId}`、`GET /internal/apps/{appId}/runs/latest-nonterminal?userId=`（断点续传查询）
- **错误码 → HTTP**：控制器内 `@ExceptionHandler` 覆盖全局 advice 的 200 返回：无/错 Bearer→401、并发→409、参数→400、不存在→404（TS 客户端依赖真实状态码）。
- **服务**：`GenerationRunServiceImpl` 每 app 一把锁（`ConcurrentHashMap`）串行化幂等检查+并发检查+落库（单实例成立）；JSON 字段校验（hutool JSONUtil）。
- **测试**：service 12 例（mock mapper，`ReflectionTestUtils.setField(mapper)`）+ controller 7 例（standalone MockMvc，**不用 @WebMvcTest**——其会扫描 mapper 需 sqlSessionFactory 导致上下文加载失败）。

## 2026-09-04 Agent 完成回调（Issue #6 已落地）

- **`POST /internal/agent/runs/{runId}/complete`**（`GenerationRunController`，Bearer 服务令牌 `internal-api.token`，无/错→401）：`GenerationRunService.completeRun(runId, AgentCompleteRequest)`——写本次对话历史（messages user/ai 按序落 `chat_history`）+ success 触发构建。
- **请求体** `AgentCompleteRequest`：`appId`/`userId`（**字符串传输，防 JS 精度丢失**）/`status`(success|failed)/`messages[{messageType,content}]`/`workspacePath`/`errorMessage`。`codeGenType` 由 Java 按 appId 查 app 表（TS Agent 不传，避免契约冗余）。
- **幂等**：`GenerationRunServiceImpl` 内存 `completedRunIds`（ConcurrentHashMap.newKeySet），同 runId 只处理一次，重复回调返回 200 丢弃（单机部署成立；重启丢失由「先 createRun 后回调」时序兜底）。
- **行为**：success → 写 messages + `BuilderExecutor.doBuild(codeGenType, workspacePath)`（构建管线不变，产物落工作区）；failed → 写一条错误历史「生成失败：{errorMessage}」，不构建。
- **配置别名**：`agent.*` 为新标准，`python-agent.*` 经 `AgentLegacyAliasPostProcessor`（EnvironmentPostProcessor，注册于 `META-INF/spring.factories`）复制为别名；`application.yml` 保留 `python-agent` 段作旧别名。
- **测试**：`GenerationRunServiceImplTest` 18 例（+completeRun 幂等/成功/失败/校验 6 例）、`GenerationRunControllerTest` 11 例（+401/200/400 4 例）、`AgentLegacyAliasPostProcessorTest` 3 例、`AgentClientTest` 5、`AgentSseAdapterTest` 3、`RunIdSinkRegistryTest` 6。

## 2026-09-04 Agent JWT 签发（Issue #12 已落地）

- **端点**：`GET /app/agent/token?appId=`（`AppController`）：登录校验（session）→ 应用归属校验（非归属 `NO_AUTH_ERROR`「无权限生成代码」）→ codeGenType 校验 → **workspacePath 由 Java 计算**（`CODE_OUTPUT_ROOT_DIR/{codeGenType}_{appId}`，与旧链路命名一致，浏览器不感知服务器布局）→ 签发短时 JWT。响应 `AgentTokenVO{token, workspacePath, expiresAt}`（**expiresAt 是字符串**——JsonConfig Long 全字符串序列化防精度丢失，前端解析需按字符串）。
- **服务**：`ai/agent/AgentJwtService`（hutool JWT HS256；`sub`=字符串 userId、`iat`/`exp` 整秒同一时基；空密钥拒签 `SYSTEM_ERROR`）；配置 `ai/agent/AgentJwtProperties`（prefix `agent.jwt`：`secret`/`ttl-minutes` 默认 10）。共享密钥与 TS Agent `JWT_SECRET` 同值（application-local.yml ↔ paimeng-ai-code-agent/.env，均不提交）。
- **测试**：`AgentJwtServiceTest` 6 例 + `AppControllerAgentTokenTest` 4 例（standalone MockMvc + 全局异常处理器；未登录 40100/应用不存在 40400/非归属 40101/归属 200 且 token 可验签+sub 字符串+路径命名一致），10/10 全绿。⚠️ hutool `JWTValidator.validateDate` 过期抛的是 `cn.hutool.core.exceptions.ValidateException`（非 JWTException）。

## 编译红线

- **JDK 21 是硬要求**（`<java.version>21</java.version>`）：用 `JAVA_HOME=/home/zdan/.sdkman/candidates/java/current`（sdkman 默认已切到 21）执行 `./mvnw compile`。⚠️ 原生 Linux 新宿主（2026-09-07 核实）尚未安装任何 JDK，编译验证前需先安装 JDK 21。
- **构建产物目录（2026-09-04）**：`pom.xml` 暴露 `maven.build.directory` 属性（默认 `${project.basedir}/target`），`<build><directory>` 引用它。WSL 运行时环境统一放 `wsl-rt-env/`（不建软链），命令带 `-Dmaven.build.directory=$PWD/wsl-rt-env/java/target`；Windows/IDE 不传该属性则用默认 `target/`。⚠️ **不要用 `-Dproject.build.directory` 覆盖**——那是模型派生属性，部分插件（surefire 等）不认，会重建根 `target/`（实测 2026-09-04）。
- T0 已落地：`config/PythonAgentProperties.java`（含 `callback-timeout-ms`）、`ai/python/PythonAgentRequest.java`（§1.2 字段 + `HistoryItem`）、`ai/python/PythonAgentClient.java`（WebClient，`health()` 可用；`stream()` 阶段 3 前抛明确 BusinessException）。
- T18 起 `AppServiceImpl` 的 `pythonChatToGenCode` 分支已调用 `PythonAgentClient.stream()`；P0（2026-09-03）回切后该分支关闭（enabled=false），代码保留待 T21 泛化处置。

## 关键事实（实现时直接依赖）

- `AppConstant.CODE_OUTPUT_ROOT_DIR = System.getProperty("user.dir") + "/tmp/code_output"`。
- `CodeGenTypeEnum`：`html` / `multi_file` / `vue_project`；`StreamMessageTypeEnum`：四类事件。
- 浏览器 SSE wire（Java 独占）：`data: {"d":"<文本>"}`（默认 message 事件）、`event: done`（构建后）、`event: business-error`。
- `AppController` 无类级 `@AuthCheck`；回调 endpoint `/api/app/chat/gen/code/callback` 只校验 Bearer token。
- 工具展示重组：复用 `ToolManager.generateToolRequestResponse` / `generateToolExecutedResult`（在 Java 侧，不迁移）。
- **Logo 图片生成后端（2026-09-07 切换）**：`LogoGeneratorTool` 走硅基流动 REST（`POST https://api.siliconflow.cn/v1/images/generations`，模型 `Kwai-Kolors/Kolors`，官方定价页标注免费），`dashscope-sdk-java` 已从 pom 移除；配置键 `siliconflow.api-key` / `siliconflow.image-model`（本地配置未填 key 时接口调用失败、工具返回空列表不阻塞主流程）。⚠️ 官方返回图片 url 有效期仅一小时，下游需及时消费。接口文档：https://api-docs.siliconflow.cn/docs/api/images-generations-post

## 约定

- 包结构 `com.zdan.paimengaicodemother.*`（`ai`/`controller`/`service`/`mapper`/`config`）；遵循阿里巴巴 Java 开发手册。
- MyBatis Flex 代码生成：`com.zdan.paimengaicodemother.generator` 包生成器，产出 mapper XML 在 `src/main/resources/mapper/`。
- 提交遵循 `AGENTS.md` 的「Git 提交」约定（Agent 代理提交时携带 `<Agent IDE>/<用户信息>`）；注释遵循 `project-comment-style` skill。

## 2026-09-04 线框每日配额内部端点（Issue #7 已落地）

- **`POST /internal/agent/wireframe/quota/acquire`**（`GenerationRunController`，Bearer 服务令牌）：`GenerationRunService.acquireWireframeDailyQuota(userId)`——线框免费 + 每用户每日独立限频（**复用 RateLimitAspect 的 Redisson 令牌桶机制**：`rate_limit:user:{userId}:wireframe_daily` 键 + `RateType.OVERALL` + 86400s 滚动窗口 + `tryAcquire(1)`）；超出 → `BusinessException(TOO_MANY_REQUEST)` → HTTP **429**「今日线框生成次数已用完，请明天再试」。键 TTL 25h（滚动 24h 窗口内不被清理，空闲回收）。
- **配置**：`AgentProperties.wireframeDailyLimit`（默认 10），`application.yml` `agent.wireframe-daily-limit: ${AGENT_WIREFRAME_DAILY_LIMIT:10}`；`GenerationRunServiceImpl` 构造器注入 `RedissonClient` + `@Value` 限频数（**测试构造器同步改 4 参**）。
- **不直接复用 `@RateLimit` 注解的原因**：注解 USER 类型靠 `userService.getLoginUser(request)`（servlet session）取用户，内部 Bearer 端点无 session；改为请求体 userId 键控（TS Agent JWT sub），机制（Redisson + `rate_limit:` 前缀）完全一致。
- **测试**：`GenerationRunServiceImplTest` 21 例（+配额成功/耗尽 429/非法 userId 3 例，mock Redisson）、`GenerationRunControllerTest` 14 例（+401/200/429 3 例）。

## 2026-09-05 积分台账 + 三剧本记账（Issue #10 已落地）

- **表**：`credit_ledger`（uk_runId 唯一幂等，`FROZEN/SETTLED/PARTIAL_REFUNDED/REFUNDED` enum，frozen/settle/refundAmount + reason + milestoneCount）；`user.credits` 余额（int 默认 0）。`generation_run.creditLedgerRef` 存台账 id（冻结时 Java 写回）。
- **CreditService**（`service/CreditServiceImpl`，@Transactional 台账+余额同库同事务）：`freeze(runId, appId, userId, intensity)`（幂等先查后插，uk_runId 兜底；冻结额 = `agent.credit.base-price` × 生成类型系数 html1/multi_file2/vue_project3 × 强度档 fast1/standard1/deep2；余额不足 → **40201**「积分不足…请先充值」→ HTTP 402）、`settleRun`（FROZEN→SETTLED 全额结算，reason=complete）、`refundRun(runId, status, filesWritten, milestoneCount)`（failed→REFUNDED 全额；aborted 且 filesWritten≤0→REFUNDED 全额（**首文件落盘前全额退**）；aborted 已写文件→PARTIAL_REFUNDED 折算——里程碑≥3 结算 70%（`interrupted-advanced-settle-ratio`）、否则 50%（basic），milestoneCount 由 completeRun 从 run.milestones JSON 解析传入）、`recharge`（管理员）、`getBalance`。
- **内部端点**：`POST /internal/agent/runs/{runId}/credit/freeze`（`GenerationRunController` + `GenerationRunService.freezeCredit`：run 存在 + creditLedgerRef 已设则幂等返回既有台账 + wireframe_confirmed 前置（否则 403「请先确认线框」）+ creditService.freeze + creditLedgerRef 写回 run）。**completeRun 扩展三态**：success→settleRun+构建+markRunTerminal(done)；failed→refundRun(FAILED)+错误历史+markRunTerminal(failed)；aborted→refundRun(ABORTED, filesWritten)+历史 ai 加 `[用户中断] ` 前缀+markRunTerminal(aborted)。**幂等**：completedRunIds 内存集 + 台账 uk_runId 双保险。
- **用户端点**：`POST /credit/recharge`（@AuthCheck admin）+ `GET /credit/balance`（session 用户）；`LoginUserVO.credits`（BeanUtil 自动复制，无需手动）。
- **e2e 实测坑**：failed 回调 messages 的 ai content 为空字符串 → Java 写历史 `addChatMessage` 抛「消息不能为空」→ 整个 completeRun 失败、退款不执行 → **completeRun 写历史时跳过空 content 消息**（failed 分支另写错误历史交代）；`CreditFreezeVO{ledgerId, frozenAmount, balance}`。
- **测试**：`CreditServiceImplTest` 17 例（三剧本折算 + 幂等 + 余额不足 + 金额计算）、`GenerationRunServiceImplTest` 31 例（+三剧本记账/冻结幂等/闸门/里程碑透传/空消息跳过）、`GenerationRunControllerTest` 18 例（+freeze 401/200/402/403）、`CreditControllerTest` 4 例。

## 2026-09-05 #10 code-review 整改（并发幂等 + 魔法值 + AC5 防护）

- **余额变动改 DB 原子 SQL（并发丢更新修复）**：`UserMapper` 加 `@Update` 自定义方法——`deductCredits(userId, amount)`（`UPDATE user SET credits = credits - #{amount} WHERE id=#{userId} AND credits >= #{amount}`，affected=0 = 余额不足/用户不存在）、`addCredits(userId, amount)`（加钱）。`UserService`/`UserServiceImpl` 透传；`CreditServiceImpl.doFreeze`/`recharge`/`refundBalance` 弃 updateById 读改写（同用户并发冻结不再互相覆盖丢更新）。**注意**：`ServiceImpl` 的 `this.mapper` 可直接访问。
- **台账 FROZEN→终态改条件更新**：`CreditLedgerMapper.transitionIfFrozen(CreditLedger)`（`UPDATE credit_ledger SET status=#{status}, settleAmount=#{settleAmount}, refundAmount=#{refundAmount}, reason=#{reason}, milestoneCount=#{milestoneCount}, updateTime=NOW() WHERE id=#{id} AND status='FROZEN'`）。settle/refund 先预读（`getFrozenOrNull`，原 `requireFrozen` 改名）算金额，再条件更新——**仅 affected=1 的线程执行加钱/结算**，并发重复回调（AC4）只一笔生效、**杜绝双重退款**；affected=0 幂等跳过。
- **踩坑：`@Update` 列名必须用实体 `@Column` 名（驼峰）**——`credit_ledger` 表列是 `settleAmount/refundAmount/milestoneCount`（DDL 驼峰定义），用下划线 `settle_amount` 报 `Unknown column 'settle_amount'`（e2e 实库实测）；单元测试 mock mapper 不解析 SQL，**@Update 语法必须 WSL 实库验证**。
- **AC5 迟到回调防护（completeRun 前置两道校验）**：① 台账已非 FROZEN（已结算/退款）→ 幂等丢弃（不依赖内存集合，进程重启丢 completedRunIds 也成立）；② run 已终态但 `terminalPhaseOf(status)`（SUCCESS/FAILED/ABORTED→done/failed/aborted）与之不符 → 拒绝（迟到错序不得改写 run 状态）。completeRun 三分支改显式 `else if ABORTED` + 兜底抛。
- **魔法值收敛**：新建 `AgentIntensityEnum`（fast/standard/deep，空/非法兜底 standard）；台账 reason 魔法字符串（complete/failed/interrupted）收敛进 `AgentCompleteStatusEnum.reason` 字段（`status.getReason()` 单一来源）。
- **其余**：`toFreezeVO` 移入 `CreditService.buildFreezeVO(ledger)`（GenerationRunServiceImpl 私有重复删除；balance 从 ledger.userId 查）；`recharge` 返回 `boolean`→`void`；`balanceOf(User)` 空值守卫提取；接口 `@param` 对齐。
- **测试**：`CreditServiceImplTest` 22 例（+并发 transition 失败不加钱/非法强度兜底/充值用户缺失/退款用户缺失等 5 例）、`GenerationRunServiceImplTest` 33 例（+迟到错序拒绝/台账终态迟到跳过 2 例）；Java 相关 **77/77**。WSL 实库 e2e 全剧本（success/failed/aborted/幂等/迟到/并发双 failed 只退一次）验证通过。

