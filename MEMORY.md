# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`。

## 一句话现状

**2026-09-03 架构定稿（经四轮设计审讯确认）：Java（业务/鉴权/积分/历史/构建）+ TS Agent（`paimeng-ai-code-agent/`，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT）+ Python RAG（`paimeng-ai-code-rag/`，day-1 只读 few-shot 检索）三服务**；权威设计 `docs/ts_agent/architecture.md`。Python Agent（T0-T20 曾实机验证但未上生产）**全面退役**：回切旧 Java AI 兜底、T21 门禁重定向为"TS Agent 契约对等 + 回归全绿"、PG 停用；**其目录已整体重命名为 `paimeng-ai-code-rag/`（2026-09-03 用户决策，取代"新建后删除"），TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）；python-agent 领域记忆已删除，重构为 ts-agent / python-rag 两域**。`docs/py_agent/` 转历史参考。**实施已启动（2026-09-03）**：**P0 已执行完毕并本地 e2e 验证**（Issue #2）→ **P1 骨架完成（Issue #3，TS Agent 服务已可运行并 curl 实测）** → **#4 run 生命周期完成（generation_run DDL + Java 内部 run API + Agent run 客户端 + 409 并发拒绝，2026-09-04）** → **#5 最小生成流+契约定稿已完成（2026-09-04，XState v5 + Vercel AI SDK 重做定稿）** → **#6 Agent→Java 回调打通已完成（2026-09-04：Java `ai/python/*` 泛化为 `ai/agent/*`，`agent.*` 配置段 + `python-agent.*` 别名保留；新增完成回调 `POST /internal/agent/runs/{runId}/complete` 写对话历史 + 触发构建，Bearer 401 + runId 幂等；TS Agent `completeRun` 客户端 + workflow 终态回调；WSL e2e 验收落库/产物/幂等/401 全通过，回退链路行为不变）** → **#7 需求工程已完成（2026-09-04：TS Agent 五维访谈（每维 2-4 选项选择题、≤2 轮、信息足够跳过）+ 免费线框（单文件 HTML 含站点地图、≤5 页、落工作区 wireframe/、快速档）+ wireframe_pending 跨请求持久化 + codegen 闸门（未确认线框拒绝，明确报错）+ 线框每日配额内部端点（复用 Redisson 限流机制，超限 429）；TS 48/48、Java 35/35，WSL e2e 两次独立会话全链路验收通过）** → **#8 生成核心移植已完成（Guardrail/解析/文件六工具/图片四工具+配额/提示词 7 份/10 工具注册；TS 85/85）** → **#12 前端通道切换已完成（2026-09-04：Java 登录态签发短时 JWT + 前端 fetch-SSE 直连 Agent + 七类事件渲染 + vite/nginx 路由；e2e 全链路验证）** → **#9 质检门禁+护栏+三档+token 计量已完成（2026-09-05：三工位循环 + 三重门禁（质检分/build/视觉 diff 以已确认线框为基准）+ 质检失败有界重试（先例 2 次）+ 护栏前三层（max_turns/max_output_tokens/max_tool_calls=50/图片 4 张随三档强度缩放，超限优雅收尾绝不硬杀）+ 输入历史滑窗 + token 计量按 run 落库；TS 128/128，code-review 双轴整改闭环）** → P2 核心能力收尾（#9 已完，待关闭）→ P3 剩余（#13 前端功能补齐、#10 积分、#11 对账、#14 灰度+T21）→ P4 RAG+盈利 MVP（手动充值；无执照，微信支付/公众号通知 v1.x）。本地环境：WSL 全栈（MySQL 8.0.46 + Redis 源码编译；PG16 已停用、5432 无监听），运行时环境文件约定 `wsl-rt-env/`（**2026-09-04：Java `target` 已迁入 `wsl-rt-env/java/target`（`-Dmaven.build.directory` 指定）；TS Agent esbuild 打包改造完成（依赖/产物在 `wsl-rt-env/ts-agent/`，服务目录零 node_modules、零软链，npm scripts 经 `scripts/run.mjs` 指向）**；前端依赖/Vite 缓存已迁入 `wsl-rt-env/frontend/`，Python RAG 的 venv/uv 缓存/解释器已由 WSL 脚本定向到 `wsl-rt-env/python/`；Windows/IDE 只使用服务目录本地依赖，调度器绝不跨平台回退，原有运行配置不变）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、过渡态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `ts-agent.md` | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、契约教训 |
| `python-rag.md` | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历、可复用骨架、day-1 结论 |
| `vue-frontend.md` | 前端约定、SSE 消费基线（#12 已切换 fetch-SSE 直连）、lint 环境坑、#13 待办 |
| `deployment.md` | 环境依赖（WSL 默认 / Windows 两套）、运行时环境布局、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/ts_agent/architecture.md`：**目标架构权威设计**（三服务/新 SSE 协议要点/run 表/护栏/计费/RAG/退役/实施顺序）
- `docs/ts_agent/contract.md`：TS Agent 浏览器 wire 契约（**#5 已定稿**）
- `docs/py_agent/task_plan.md`：Java↔Python 契约与任务（**历史参考**，TS 移植参考源）
- `docs/py_agent/progress.md`：Python Agent 进度日志（历史，含退役决策记录）
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 项目约定与任务资料路由

## 下一步

按 `docs/ts_agent/architecture.md` §11 执行：**P0（止血回退）已于 2026-09-03 执行完毕**（Issue #2，e2e 证据）——① `application-local.yml` 已回切 `python-agent.enabled: false`（旧 Java AI 链路全流程验证：注册/登录/建应用/SSE 生成/构建/部署/历史落库）；② PG 确认停用（无服务、无自启、5432 无监听）；③ 记忆/文档已同步。**P1 进行中**：TS Agent 骨架（Issue #3）**已完成并关闭**（`paimeng-ai-code-agent/`，Fastify + JWT 离线验签 + 工作区沙箱 + 冒烟 SSE，`npm test` 24/24）。**#4 run 生命周期已完成（2026-09-04，待关闭）**：`generation_run` 表 DDL 已落库（phase 显式 ENUM + JSON 字段）+ Java 内部 run API（`/api/internal/*`，Bearer→401、并发→409「当前有进行中的任务」、runId 幂等）+ TS Agent run 客户端（`src/internal/runClient.ts`）；Java 测试 19/19、TS 33/33、curl+实库+跨服务集成全验证。**#6 回调打通已完成（2026-09-04，待关闭）**：客户端泛化（`agent.*`）+ 完成回调端点（写历史+构建，Bearer 401 + runId 幂等）+ TS `completeRun`；#6 相关 Java 测试 46/46、TS 37/37、WSL e2e 全链路验收通过。**#7 需求工程已完成（2026-09-04，待关闭）**：TS Agent 五维访谈（2-4 选项选择题、≤2 轮、信息足够跳过）+ 免费线框（单文件 HTML 含站点地图、≤5 页、快速档、落工作区 wireframe/）+ wireframe_pending 跨请求持久化 + codegen 闸门（未确认线框拒绝，明确报错）+ 线框每日配额内部端点（复用 Redisson 限流机制，超限 429）；TS 48/48、Java 35/35，WSL e2e 两次独立会话「访谈→线框→确认→codegen」全链路验收通过。**#8 生成核心移植已完成（2026-09-04，已关闭）**：Guardrail（`src/guardrails.ts`，interview 阶段拦截→failed）+ 代码块解析（`src/codegen/parsing.ts`，写盘前解析文件集）+ 文件六工具（`src/tools/fileTools.ts`）+ 图片四工具 + 配额 4 张/run（`src/tools/imageTools.ts`）+ 提示词 7 份复制进 `src/prompts/`（codegen 三份注入导览组件要求）+ workflow 全套 10 工具注册 + fake LLM 产物内嵌 onboarding-tour 组件；TS 85/85、type-check 通过，5 项验收逐条勾选。**#12 前端通道切换已完成（2026-09-04，待关闭）**：Java 签发短时 JWT（`GET /app/agent/token`：登录+归属校验 + workspacePath 由 Java 计算；`AgentJwtService` hutool HS256，`agent.jwt.secret` 与 TS Agent `JWT_SECRET` 同值）+ 前端 EventSource 改 fetch-SSE 直连（`src/utils/agentSse.ts` 解析器 + AppChatPage 七类事件渲染 + 401 明确重新登录提示）+ vite `/agent` 代理与 `deploy/nginx.conf.example` 生产模板；Java 10/10 新测试全绿、前端 type-check/lint 绿（顺带修复 lint 环境：NODE_PATH + 生成文件豁免；#12 时引入的 dev `--configLoader runner` 与插件 `enforce: 'pre'` 两个缺陷已于 2026-09-05 修正——runner 两平台崩溃、'pre' 绕过预构建致白屏，见 progress.md 2026-09-05 条目）、WSL e2e 直连与经代理全链路「登录→token→访谈→线框→确认→stream 七类事件→run done+历史落库+产物」全通过。**下一步 #9 已全部完成（2026-09-05，待关闭）**：三工位循环 + 三重门禁（结构化质检分 + build 验证 + 视觉 diff 以已确认线框为基准）+ 质检失败有界重试（先例 2 次）+ 护栏前三层（max_turns / max_output_tokens / max_tool_calls=50 / 图片 4 张，随三档强度 fast/standard/deep 缩放）+ 超限优雅收尾（注入收尾指令，绝不硬杀）+ 输入历史滑窗（最近 10 轮全文 + 更早摘要）+ token 计量按 run 落库；TS 128/128、type-check/build 通过，code-review 双轴整改闭环。**下一步 #10（积分：冻结/结算/退款 + 对话中断）与 #13（前端功能补齐：线框确认 UI/档位选择/中止/积分显示）并行可行**。实施进度日志：`docs/ts_agent/progress.md`。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/ts_agent/progress.md` 追加一行（含日期与命令证据）。
