# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`。

## 一句话现状

**2026-09-03 架构定稿（经四轮设计审讯确认）：Java（业务/鉴权/积分/历史/构建）+ TS Agent（`paimeng-ai-code-agent/`，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT）+ Python RAG（`paimeng-ai-code-rag/`，day-1 只读 few-shot 检索）三服务**；权威设计 `docs/ts_agent/architecture.md`。Python Agent（T0-T20 曾实机验证但未上生产）**全面退役**：回切旧 Java AI 兜底、T21 门禁重定向为"TS Agent 契约对等 + 回归全绿"、PG 停用；**其目录已整体重命名为 `paimeng-ai-code-rag/`（2026-09-03 用户决策，取代"新建后删除"），TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）；python-agent 领域记忆已删除，重构为 ts-agent / python-rag 两域**。`docs/py_agent/` 转历史参考。**实施已启动（2026-09-03）**：**P0 已执行完毕并本地 e2e 验证**（Issue #2）→ **P1 骨架完成（Issue #3，TS Agent 服务已可运行并 curl 实测）** → **#4 run 生命周期完成（generation_run DDL + Java 内部 run API + Agent run 客户端 + 409 并发拒绝，2026-09-04）** → #5 最小生成流+契约定稿 → P2 核心能力 → P3 联调切换（含 T21 与前端改造）→ P4 RAG+盈利 MVP（手动充值；无执照，微信支付/公众号通知 v1.x）。本地环境：WSL 全栈（MySQL 8.0.46 + Redis 源码编译；PG16 已停用、5432 无监听），运行时环境文件约定 `wsl-rt-env/`（**2026-09-04：Java `target` 已迁入 `wsl-rt-env/java/target`（`-Dmaven.build.directory` 指定）；TS Agent esbuild 打包改造完成（依赖/产物在 `wsl-rt-env/ts-agent/`，服务目录零 node_modules、零软链，npm scripts 经 `scripts/run.mjs` 指向）**；前端 node_modules、Python `.venv` 仍待迁）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、过渡态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `ts-agent.md` | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、契约教训 |
| `python-rag.md` | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历、可复用骨架、day-1 结论 |
| `vue-frontend.md` | 前端约定、SSE 消费基线、P3 计划改造 |
| `deployment.md` | 环境依赖（WSL 默认 / Windows 两套）、运行时环境布局、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/ts_agent/architecture.md`：**目标架构权威设计**（三服务/新 SSE 协议要点/run 表/护栏/计费/RAG/退役/实施顺序）
- `docs/ts_agent/contract.md`：TS Agent 浏览器 wire 契约（**P1 产出，待创建**）
- `docs/py_agent/task_plan.md`：Java↔Python 契约与任务（**历史参考**，TS 移植参考源）
- `docs/py_agent/progress.md`：Python Agent 进度日志（历史，含退役决策记录）
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 约定（包结构、风格、命令）

## 下一步

按 `docs/ts_agent/architecture.md` §11 执行：**P0（止血回退）已于 2026-09-03 执行完毕**（Issue #2，e2e 证据）——① `application-local.yml` 已回切 `python-agent.enabled: false`（旧 Java AI 链路全流程验证：注册/登录/建应用/SSE 生成/构建/部署/历史落库）；② PG 确认停用（无服务、无自启、5432 无监听）；③ 记忆/文档已同步。**P1 进行中**：TS Agent 骨架（Issue #3）**已完成并关闭**（`paimeng-ai-code-agent/`，Fastify + JWT 离线验签 + 工作区沙箱 + 冒烟 SSE，`npm test` 24/24）。**#4 run 生命周期已完成（2026-09-04，待关闭）**：`generation_run` 表 DDL 已落库（phase 显式 ENUM + JSON 字段）+ Java 内部 run API（`/api/internal/*`，Bearer→401、并发→409「当前有进行中的任务」、runId 幂等）+ TS Agent run 客户端（`src/internal/runClient.ts`）；Java 测试 19/19、TS 33/33、curl+实库+跨服务集成全验证。下一步 #5：假 LLM 最小生成流 + 新 SSE 协议契约定稿。实施进度日志：`docs/ts_agent/progress.md`。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/ts_agent/progress.md` 追加一行（含日期与命令证据）。
