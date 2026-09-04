# Agents Instructions

派蒙 AI 应用工坊：基于 AI 的零代码应用生成平台（自然语言 → 代码生成 → 预览/部署）。
当前形态：三服务过渡态——Java（`src/`，过渡期主链路）+ TS Agent（`paimeng-ai-code-agent/`，实施中）+ Python RAG（`paimeng-ai-code-rag/`，P4）。

- 项目详细上下文：[CONTEXT.md](CONTEXT.md)
- 跨会话工作记忆：[MEMORY.md](MEMORY.md)（领域记忆在 `.agents/memories/`）

## 按任务读权威文档（先查再动，本文件不重复其内容）

| 任务领域 | 先读 |
|---|---|
| 目标架构 / wire 协议 / 计费 / RAG / 退役方案 | `docs/ts_agent/architecture.md` |
| Java 侧状态、编译红线、迁移残留、包结构约定 | `.agents/memories/java-backend.md` |
| TS Agent 实施状态、移植参考、契约教训 | `.agents/memories/ts-agent.md` |
| 环境依赖、启动、运行时环境布局（`wsl-rt-env/`）、敏感文件、共享工作区 | `.agents/memories/deployment.md` |
| 前端约定、SSE 消费基线、P3 改造 | `.agents/memories/vue-frontend.md` |
| Python RAG（P4） | `.agents/memories/python-rag.md` |
| 历史（Python Agent 契约/进度，TS 移植参考源） | `docs/py_agent/` |
| 启动与排障 SOP | `.agents/skills/project-startup-guardrail/SKILL.md` |
| Issue 工作流 | `docs/agents/issue-tracker.md` |

## 常用命令

> **运行时环境统一在 `wsl-rt-env/`**（不在各服务目录内），**通过命令指定、不建软链**：Java 构建产物在 `wsl-rt-env/java/target`（pom 暴露 `maven.build.directory` 属性，默认 `target/`；WSL 用 `-Dmaven.build.directory=$PWD/wsl-rt-env/java/target` 指定）；TS Agent 的依赖与构建产物在 `wsl-rt-env/ts-agent/`（`node_modules` + esbuild 自包含产物 `dist/app.bundle.mjs`；npm scripts 经 `scripts/run.mjs` 调度器自动指向，服务目录内零 node_modules、零软链；**依赖安装必须以归位脚本收尾**）；前端 node_modules 为存量待迁移（见 `deployment.md`）。

| Task | Command |
|---|---|
| 运行 Java 后端（WSL） | `./mvnw -Dmaven.build.directory=$PWD/wsl-rt-env/java/target spring-boot:run`（8123；API 文档 `http://localhost:8123/api/doc.html`；Windows/IDE 不传该属性用默认 `target/`） |
| Java 测试（WSL） | `./mvnw -Dmaven.build.directory=$PWD/wsl-rt-env/java/target test`；单个：追加 `-Dtest=类名` |
| **TS Agent 安装依赖** | `cd paimeng-ai-code-agent && npm install && bash scripts/sync-node-modules.sh`（勿用 `npm ci`） |
| 运行 TS Agent | `cd paimeng-ai-code-agent && npm run dev`（8092；esbuild 打包 + watch 自动重启） |
| TS Agent 测试 / 类型检查 | `cd paimeng-ai-code-agent && npm test` / `npm run type-check` |
| 前端 dev / build / type-check / lint | `cd paimeng-ai-code-mother-frontend && npm run <script>` |
| 生成 API 类型 | `cd paimeng-ai-code-mother-frontend && npm run openapi2ts`（需后端已启动） |

> 依赖安装、本地服务起停、运行时环境布局与排障：见 `deployment.md` 与启动 SOP，本文件不重复。

## 硬约定

- **敏感文件不提交**：`application-local.yml`、各服务 `.env`（仓库内只留 `*.example` 模板）。
- **运行时环境统一放 `wsl-rt-env/`**（venv / node_modules / 构建产物；布局与现状见 `deployment.md`）。
- **Agent 代理提交**：commit message 携带 `<Agent IDE>/<用户信息>` 标注。
- **注释**：遵循 `project-comment-style` skill；Java 同时遵循阿里巴巴开发手册。
- **不擅自切换** `python-agent.enabled`（改变代码生成链路）。
