# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`。

## 一句话现状

**2026-09-03 架构定稿（经四轮设计审讯确认）：Java（业务/鉴权/积分/历史/构建）+ TS Agent（新建，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT）+ Python RAG（新建 `paimeng-ai-code-rag/`，day-1 只读 few-shot 检索）三服务**；权威设计 `docs/ts_agent/architecture.md`。Python Agent（T0-T20 已实机验证但未上生产）**全面退役**：回切旧 Java AI 兜底、T21 门禁重定向为"TS Agent 契约对等 + 回归全绿"、PG 即刻停用、`paimeng-ai-code-agent/` 目录待 RAG 骨架复用后删除（git 历史即移植参考）；`docs/py_agent/` 转历史参考。**实施未启动**：P0（回切+停 PG，1 天）→ P1 骨架 → P2 核心能力 → P3 联调切换（含 T21 与前端改造）→ P4 RAG+盈利 MVP（手动充值；无执照，微信支付/公众号通知 v1.x）。本地环境：WSL 全栈（MySQL 8.0.46 + Redis + PG16 待停），运行时环境文件约定 `wsl-rt-env/`（待迁移）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、过渡态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `python-agent.md` | Python Agent 退役状态与移植参考清单 |
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

按 `docs/ts_agent/architecture.md` §11 执行：**P0（止血回退）待执行**——① `application-local.yml` 置 `python-agent.enabled: false` 回切旧 Java AI；② 停用 PG16（runbook 留 `deployment.md`）；③ 记忆/文档更新（本文件与 `AGENTS.md`/`architecture.md` 已完成 2026-09-03）。随后 P1：TS Agent 骨架（Fastify + JWT 验签 + 工作区沙箱）+ `generation_run`/积分/反馈表 DDL + 新 SSE 协议契约。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/py_agent/progress.md`（或后续 `docs/ts_agent/progress.md`）追加一行（含日期与命令证据）。
