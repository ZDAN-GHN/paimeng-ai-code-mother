# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 任务完成链 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`；逐票实施细节与命令证据在 `docs/ts_agent/progress.md`。

## 一句话现状

三服务架构（2026-09-03 经四轮设计审讯定稿）：**Java**（业务/鉴权/积分/历史/构建）+ **TS Agent**（`paimeng-ai-code-agent/`，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT）+ **Python RAG**（`paimeng-ai-code-rag/`，P4 未动工）；权威设计 `docs/ts_agent/architecture.md`。旧 Python Agent 已全面退役（目录整体重命名为 RAG 复用起点，`docs/py_agent/` 转历史参考，PG 停用）。实施推进至 **P3 收尾**：P0-P2 全部完成，#11 契约对账（T21「契约对等」判据通过，TS 144/144）、#13 前端功能补齐均已完成，**仅剩 #14 灰度 + T21 删除旧链路**。当前宿主为原生 Linux Mint（MySQL/Redis/SearXNG/Nginx 经 docker compose），运行环境约定见 `deployment.md`。

## 任务完成链（详情与命令证据见 `docs/ts_agent/progress.md` 与各领域记忆）

| 票 | 日期 | 一句话 |
|---|---|---|
| #2 (P0) | 2026-09-03 | 回切旧 Java AI 主链路（`python-agent.enabled=false`），WSL e2e 验证 |
| #3 (P1) | 2026-09-03 | TS Agent 骨架：Fastify 5 + jose + 沙箱 + JWT 401 矩阵 |
| #4 | 2026-09-04 | run 生命周期：`generation_run` DDL + Java 内部 API + 409 并发拒绝 |
| #5 | 2026-09-04 | 最小生成流 + 契约定稿（XState v5 + AI SDK v7，`docs/ts_agent/contract.md`） |
| #6 | 2026-09-04 | Agent→Java 回调打通：`ai/agent/` 泛化 + 完成回调（Bearer + runId 幂等） |
| #7 | 2026-09-04 | 需求工程：五维访谈 + 免费线框 + codegen 闸门 + 每日配额 429 |
| #8 | 2026-09-04 | 生成核心移植：Guardrail/解析/文件六工具/图片四工具/提示词 7 份 |
| #12 | 2026-09-04 | 前端通道切换：Java 签发短时 JWT + fetch-SSE 直连 + 七类事件渲染 |
| #9 | 2026-09-05 | 质检门禁（三工位 + 三重门禁）+ 护栏 + 三档强度 + token 计量 |
| #10 | 2026-09-05 | 积分协议（冻结/结算/退款台账）+ 对话中断按里程碑退款 |
| #11 | 2026-09-07 | 契约对账 84 例（72 覆盖/3 差异/9 演进），T21 判据通过，144/144 |
| #13 | 2026-09-08 | 前端功能补齐：旅程状态机/访谈卡/线框确认/强度选择/中止/余额 |

- 另：2026-09-07 双源图片搜索 + SearXNG 容器（`java-backend.md`/`deployment.md`）；2026-09-08 nginx 部署路由容器 + 本地库全量 dump 迁移 + 快速档半价定价（`deployment.md`/`java-backend.md`/`vue-frontend.md`）。
- #13 仅剩浏览器 UI 人工走查（AC1 勾选留用户）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、过渡态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `ts-agent.md` | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、契约教训 |
| `python-rag.md` | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历、可复用骨架、day-1 结论 |
| `vue-frontend.md` | 前端约定、SSE 消费基线、P3 计划改造 |
| `deployment.md` | 环境依赖（原生 Linux 默认 / WSL 两套）、运行时环境布局、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/ts_agent/architecture.md`：**目标架构权威设计**（三服务/新 SSE 协议要点/run 表/护栏/计费/RAG/退役/实施顺序）
- `docs/ts_agent/contract.md`：TS Agent 浏览器 wire 契约（#5 已定稿）
- `docs/ts_agent/contract-parity.md`：契约对等报告（#11 终稿，T21 判据依据）
- `docs/ts_agent/progress.md`：TS Agent 实施进度日志（逐票细节与命令证据）
- `docs/py_agent/`：Python Agent 历史参考（task_plan/progress/findings/t21_delete_plan）
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 项目约定与任务资料路由

## 下一步

**#14 灰度 + T21**：删除范围按 `docs/py_agent/t21_delete_plan.md`（`createApp` 保留 Java 侧 AI 路由），判据 = #11 契约对等已通过 + 回归全绿 → P4 RAG + 盈利 MVP（手动充值已就绪；无执照，微信支付/公众号通知 v1.x）。每完成一个任务：更新 `.agents/memories/` 对应文档 + 本文件现状与完成链 + `docs/ts_agent/progress.md` 追加一行（含日期与命令证据）。
