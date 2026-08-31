# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/py_agent/`。

## 一句话现状

Java (Spring Boot) + Python (FastAPI) **双后端重构中**。阶段 1（T0-T5）与阶段 2（T6-T8）已全部落地并验证：`./mvnw compile` 通过（JDK 21）、`paimeng-ai-code-agent` 子项目已建（`uv run pytest` 55 passed）。下一步进入阶段 2 后半（T9-T13，Agent 能力迁移）。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 双后端架构决策（B2/H4/数据分工/灰度/依赖策略） |
| `java.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `python-agent.md` | Python Agent 状态、依赖坑、目录结构与下一步任务 |
| `frontend.md` | 前端约定、SSE 消费基线 |
| `deployment.md` | 环境依赖、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/py_agent/task_plan.md`：设计、Java↔Python 契约（§1）、任务 T0-T21、验收（§5）
- `docs/py_agent/progress.md`：进度日志与架构决策记录
- `docs/py_agent/findings.md`：现状事实核对
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 约定（包结构、风格、命令）

## 下一步

阶段 2：**T9**（Guardrail）→ **T10**（代码解析+工作区写入）→ **T11-T13**（graph/streaming/callback）。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/py_agent/progress.md` 追加一行（含日期与命令证据）。
