# .agents/memories — 跨会话工作记忆

> 本目录存放 Agent 的**跨会话工作记忆**：状态快照、关键决策摘要、踩坑，随会话持续更新。
> 与 `docs/py_agent/` 的边界：`docs/` 是**提交前须 review 的权威设计稿**；本目录是**随时可改的工作记忆**（摘要 + 指针，不重复权威全文）。
> 根目录 `MEMORY.md` 是极简总入口（一句话现状 + 指向本目录）。

## 文档划分

| 文档 | 覆盖内容 | 主要读者 |
|---|---|---|
| `architecture.md` | 双后端架构决策（B2 职责边界、H4 回调超时、数据分工、首次判定、灰度开关、依赖策略） | 所有 Agent |
| `java.md` | Java 侧状态、编译红线、迁移残留、包结构与代码风格约定 | 碰 Java 的 Agent |
| `python-agent.md` | Python Agent 子项目状态、FastAPI/LangGraph 依赖坑、下一步任务 | 碰 Python 的 Agent |
| `frontend.md` | 前端路径、代码风格、SSE 消费基线 | 碰前端的 Agent |
| `deployment.md` | 环境依赖、敏感文件、共享工作区、启动命令 | 跑环境/部署的 Agent |

## 更新约定

- **每次完成任务**：更新对应领域文档 + 根目录 `MEMORY.md` 的「一句话现状」，并在 `docs/py_agent/progress.md` 追加一行（含日期与命令证据）。
- **权威变更**：涉及 Java↔Python 契约、验收、任务的改动，必须先改 `docs/py_agent/task_plan.md` 并走 `agent-design-review`；本目录只做同步摘要。
- **文档尽量薄**：只写「当前状态 + 决策 + 坑 + 指针」，详细论证留在 `docs/`。

## 快速入口

- 权威设计/契约/验收：`docs/py_agent/task_plan.md`
- 进度与决策记录：`docs/py_agent/progress.md`
- 现状事实：`docs/py_agent/findings.md`
