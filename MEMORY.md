# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/py_agent/`。

## 一句话现状

Java (Spring Boot) + Python (FastAPI) **双后端重构中**。阶段 1-4 实现（T0-T20）已全部落地；T14a/T18/T20 已**实机验证**（用户态 PostgreSQL 16 + MySQL 8.0.36 + Redis 7.2.5 + 后端可启动 + DeepSeek 在线）：旧链路三类型基线已录、Python 链路三类型灰度实测通过、`sse_baseline.py` 逐事件比较 `DIFF 为空`。Python `uv run pytest` 87 passed（contract 11）；Java 新链路单测 14 passed（Client 5 + Registry 6 + Adapter 3，全量 30 用例中仅旧链路/langgraph4j/环境依赖用例失败，均为 T21 删除目标或需 Chrome/mmdc/网络）。阶段 5 T21 就绪方案已定稿（`docs/py_agent/t21_delete_plan.md`），剩余为稳定期门禁 T21（灰度 ≥7 天 + 全绿后删除旧 AI 实现）。**2026-09-01 WSL 全栈启动验证通过**：依赖服务全部落在 WSL（用户态 MySQL 8.0.46 root/root 已建表 + Redis + 用户态 PG16），Java 8123 / Python 8090 / 前端 5173 三服务健康检查全通；本地环境默认 WSL，此前 Windows 环境记录保留（详见 `.agents/memories/deployment.md`）。**2026-09-01 起运行时环境文件统一放仓库根目录 `wsl-rt-env/`**（`wsl-rt-env/{python,frontend,java}` 对应 Python venv / 前端 node_modules / Java target，当前待迁移，见 `.agents/memories/deployment.md`）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 双后端架构决策（B2/H4/数据分工/灰度/依赖策略） |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `python-agent.md` | Python Agent 状态、依赖坑、目录结构与下一步任务 |
| `vue-frontend.md` | 前端约定、SSE 消费基线 |
| `deployment.md` | 环境依赖（WSL 默认 / Windows 两套）、运行时环境布局（wsl-rt-env 新约定）、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/py_agent/task_plan.md`：设计、Java↔Python 契约（§1）、任务 T0-T21、验收（§5）
- `docs/py_agent/progress.md`：进度日志与架构决策记录
- `docs/py_agent/findings.md`：现状事实核对
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 约定（包结构、风格、命令）

## 下一步

阶段 4：T19/T20 已实机验证完成；阶段 5（T21 就绪）已完成删除方案 `docs/py_agent/t21_delete_plan.md`（含门禁前回归复验与**用户决策：createApp 保留 Java 侧 AI 路由**）。剩余 **T21（部署期门禁）**：开发环境切 Python 灰度 ≥7 天 + T19/T20 回归全绿 + 无 P0/P1 后删除旧 Java AI 实现（`ai/codegen` 执行类、`langgraph4j`、`ai/guardrail`、`core/parser`/`core/saver`、`utils/ClazzScanner`；**保留** `ai/codegen/route/*` 路由链、`ai/tools` 展示格式、`core/handler`、`BuilderExecutor`、langchain4j 依赖）。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/py_agent/progress.md` 追加一行（含日期与命令证据）。
