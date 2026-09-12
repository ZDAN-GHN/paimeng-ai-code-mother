# Paimeng Dev SOP

派蒙 AI 应用工坊：自然语言生成、预览和部署零代码应用。

- 当前架构：TS Agent（`paimeng-ai-code-agent/`，生成主链路，P3 收官）+ Java（`src/`，业务/鉴权/积分/构建，旧 AI 已退役）+ Python RAG（`paimeng-ai-code-rag/`，P4）。
- `paimeng-ai-code-mother-microservice/` 是废弃尝试，不作为开发或迁移前提。
- 本文件仅保留 Agent 约定和任务索引；架构、运行细节与进度各自维护在唯一权威资料中。

## 核心入口

| 内容                            | 资料                                                             |
| ----------------------------- | -------------------------------------------------------------- |
| 项目领域、Java 既有分层、核心实体           | [CONTEXT.md](CONTEXT.md)                                       |
| 跨会话记忆、当前状态、领域资料索引与下一步         | [MEMORY.md](MEMORY.md)                                         |
| 目标架构、服务拓扑、wire 协议、计费、RAG、退役方案 | [docs/ts_agent/architecture.md](docs/ts_agent/architecture.md) |
| Issue 状态、创建与关闭流程              | [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)   |

## 按任务查阅

| 任务                               | 资料                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| TS Agent 实施、服务运行、测试              | [Agent README](paimeng-ai-code-agent/README.md)；进度与验证证据见 [docs/ts_agent/progress.md](docs/ts_agent/progress.md) |
| Vue 前端开发、运行、测试                   | [前端 README](paimeng-ai-code-mother-frontend/README.md)                                                          |
| Python RAG（P4）                   | [RAG README](paimeng-ai-code-rag/README.md)                                                                     |
| 依赖、启动、排障、运行时目录、共享工作区             | [启动 SOP](.agents/skills/project-startup-guardrail/SKILL.md)                                                     |
| Python Agent 历史移植参考与旧 Java AI 删除 | [docs/py_agent/](docs/py_agent/)（非当前架构权威）；删除范围见 [t21_delete_plan.md](docs/py_agent/t21_delete_plan.md)          |

## 硬约定

- 敏感文件不提交：`application-local.yml`、各服务 `.env`；仓库只保留 `*.example` 模板。
- 运行时环境按宿主分流（2026-09-07 起）：**原生 Linux 与 Windows/IDE 使用各服务默认目录与标准命令**（Java `target/`、Node `node_modules/` + `dist/`、Python `.venv/`），不指定环境输出目录；**仅 WSL 宿主**统一放 `wsl-rt-env/` 并经 `*-wsl.sh` 脚本命令指定，不建软链。三平台互不回退。
- Subagent 的独立 Git worktree 统一保存到 `.agents/worktrees/`；创建前必须明确可复现基线，禁止隐式依赖主工作区未提交改动。
- 不擅自切换 `ts-agent.enabled`，这会改变代码生成可用链路（关闭后前端得到 40410 明确报错；旧 Java AI 链路已删除，回退手段为 git 回滚）。
- Agent 参与或生成的提交必须在 commit message 末尾添加 `Assisted-by: <agent-name>/<model-id>` trailer（例如 `Assisted-by: Pi/gpt-5.6-terra`）；不得使用 `Co-authored-by` 替代；`Signed-off-by` 仅由人类添加。
- 每次改动完成后，必须创建对应的 Git commit，以便后续追踪和回滚；禁止留下未提交的改动。
- 注释遵循 `project-comment-style`；Java 同时遵循阿里巴巴开发手册。
- 测试分包与被测代码路径对称（全模块适用）：测试文件按被测对象所在包/目录镜像分包，源码按领域分包时测试树同构（含子目录）；跨域集成测试与测试基建（helpers/fixtures）放测试树顶层。
- **Issue 验收硬门槛（认知对齐原则）**：有验收项的 issue，交付时须逐条勾选 Acceptance criteria 复选框（`- [ ]` → `- [x]`）；有验收却未勾选，一律视作没有验收。

## Agent skills

高频技能在此列出以提升命中与触发稳定性；完整可用清单以会话技能目录为准，低频技能不列，避免诱导无效加载：

| 技能                            | 触发时机                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `project-comment-style`       | 添加或补全注释、编写类/方法 Javadoc、核对注释样式等                                                   |
| `memory-management`           | 任务产生或修正可复用的事实、决策、约束、踩坑，或既有记忆需增删改时                                                |
| `memory-quality-audit`        | 对 `.agents/memories/` 记忆文档或 `MEMORY.md` 做过新增/修改/删除/重命名后，交付前即使未被要求也应主动使用本技能审查记忆质量 |
| `code-review`                 | 审查分支、PR 或工作区改动，或要求 "review since X" 时；完成一段自包含改动、准备提交前即使未被要求也应主动使用本技能自查           |
| `agent-design-review`         | 首次生成方案设计，或要求审查、修订方案设计时                                                           |
| `agents-md`                   | 更新/维护 AGENTS.md 或 CLAUDE.md                                                      |
| `codebase-design`             | 设计或改进模块接口、划分职责、找接缝等结构设计讨论时（"这个模块怎么设计"、"接口怎么拆"、"这段逻辑放哪"、"怎么更好测"）                  |
| `make-interfaces-feel-better` | 开发或审查前端页面/组件、实现动画与 hover/阴影/圆角/图标等视觉细节、界面"感觉不对"（feels off）想打磨时                   |

### Issue tracker

Issues are tracked in this repository's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Web project rules

本仓库不是单一 TypeScript 全栈应用：Java `src/` 是业务后端，`paimeng-ai-code-mother-frontend/` 是 Vue 3 前端，`paimeng-ai-code-agent/` 是 Node TS Agent，`paimeng-ai-code-rag/` 是 Python RAG。不要把默认的 pnpm、React、共享 Zod 包或前端 Vitest 约定套用到不存在的模块。

按任务读取详细规则：

| 任务 | 详细规则 |
| --- | --- |
| 通用工程、目录边界、变更范围 | [.agents/rules/engineering.md](.agents/rules/engineering.md)、[project-boundaries.md](.agents/rules/project-boundaries.md) |
| TypeScript、API 契约、前端 | [typescript.md](.agents/rules/typescript.md)、[api-contracts.md](.agents/rules/api-contracts.md)、[frontend.md](.agents/rules/frontend.md) |
| 管理后台 UI | [admin-ui.md](.agents/rules/admin-ui.md) |
| Java、数据库、错误与日志 | [backend.md](.agents/rules/backend.md)、[database.md](.agents/rules/database.md)、[errors.md](.agents/rules/errors.md)、[logging.md](.agents/rules/logging.md) |
| 测试与交付验证 | [testing.md](.agents/rules/testing.md) |

> Frontend and backend must share API contracts. Request/response schemas and inferred types must live in a shared contract layer. Frontend code must not hand-write backend response types.

在本仓库中，Java OpenAPI/接口定义与前端 `src/api/` 生成类型共同承担该契约层；TS Agent 的浏览器 wire 协议以 `docs/ts_agent/contract.md` 与 TS 侧 Zod schema 为准。

规则文档只补充本入口，不替代 `CONTEXT.md`、架构文档、启动 SOP 和各子项目 README；发生冲突时，以更具体、更新的项目权威文档为准。
