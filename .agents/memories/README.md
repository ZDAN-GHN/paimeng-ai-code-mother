# .agents/memories — 跨会话工作记忆

> 本目录存放 Agent 的**跨会话工作记忆**：状态快照、关键决策摘要、踩坑，随会话持续更新。
> 与 `docs/` 的边界：`docs/` 是**提交前须 review 的权威设计稿**（当前架构权威为 `docs/ts_agent/architecture.md`，`docs/py_agent/` 转历史参考）；本目录是**随时可改的工作记忆**（摘要 + 指针，不重复权威全文）。
> 根目录 `MEMORY.md` 是极简总入口（一句话现状 + 指向本目录）。

## 文档划分

| 文档 | 覆盖内容 | 主要读者 |
|---|---|---|
| [architecture.md](architecture.md) | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、退役状态、架构级坑（Cordis 类目错误、双 Agent 共存禁令）、代码布局约定（测试分包对称） | 所有 Agent |
| [java-backend.md](java-backend.md) | Java 侧状态、编译红线、迁移残留、2026-09-03 新增职责（JWT/积分/回调） | 碰 Java 的 Agent |
| [ts-agent.md](ts-agent.md) | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、Python 实测契约教训 | 碰 TS Agent 的 Agent |
| [python-rag.md](python-rag.md) | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历（旧 Python Agent 重命名）、可复用骨架、day-1 设计结论 | 碰 RAG 的 Agent |
| [vue-frontend.md](vue-frontend.md) | 前端路径、代码风格、SSE 消费基线、P3 计划改造 | 碰前端的 Agent |
| [deployment.md](deployment.md) | 环境依赖、运行时环境布局（wsl-rt-env 新约定）、敏感文件、共享工作区、启动命令 | 跑环境/部署的 Agent |

## 更新约定

- **每次完成任务**：更新对应领域文档 + 根目录 `MEMORY.md` 的「一句话现状」，并在进度日志（TS Agent 实施期：`docs/ts_agent/progress.md`；Python Agent 历史：`docs/py_agent/progress.md`）追加一行（含日期与命令证据）。
- **权威变更**：涉及目标架构、契约、验收的改动，必须先改 `docs/ts_agent/architecture.md`（或对应的 `docs/ts_agent/contract.md`）并走 `agent-design-review`；本目录只做同步摘要。
- **文档尽量薄**：只写「当前状态 + 决策 + 坑 + 指针」，详细论证留在 `docs/`。

## 快速入口

- 目标架构权威设计：`docs/ts_agent/architecture.md`
- 浏览器 wire 契约（P1 产出）：`docs/ts_agent/contract.md`
- 历史参考（Python Agent 契约/验收/任务）：`docs/py_agent/task_plan.md`
- 进度与决策记录（历史）：`docs/py_agent/progress.md`
- 现状事实（历史）：`docs/py_agent/findings.md`
