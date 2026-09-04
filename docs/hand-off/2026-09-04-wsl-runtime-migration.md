# Handoff

## Context
用户要求所有 WSL 运行时环境物理放在仓库根目录 `wsl-rt-env/`，通过命令、环境变量或工具配置指定，禁止软链；同时要求 Windows 宿主机 IDE 运行保持原有配置，不因 WSL 方案受影响。

本次用户没有提供额外 focus 参数。当前迁移脚本与调度器已经覆盖 Java、TS Agent、前端和 Python RAG：WSL 运行时均在 `wsl-rt-env/`，Windows/IDE 保持各服务目录本地环境，运行时调度按平台严格选址，不会读取 WSL 环境。

## Completed State
- Java 已通过 Maven 属性指定 WSL 构建目录：`-Dmaven.build.directory=$PWD/wsl-rt-env/java/target`；未传该属性时默认使用项目 `target/`，因此 Windows/IDE 现有运行配置保持兼容。详见 `pom.xml` 和 `.agents/memories/deployment.md`。
- TS Agent 已完成 esbuild 自包含打包、去除服务目录 `node_modules` 软链，提交为 `85be778`（前一 Java 相关提交为 `3c2717f`）。详见 `paimeng-ai-code-agent/scripts/run.mjs`、`paimeng-ai-code-agent/package.json`、`paimeng-ai-code-agent/vitest.config.mjs` 和 `.agents/memories/deployment.md`。
- TS Agent WSL 运行时位置为 `wsl-rt-env/ts-agent/node_modules` 与 `wsl-rt-env/ts-agent/dist/app.bundle.mjs`；npm scripts 由调度器按平台严格选择依赖：WSL/Linux 只使用 WSL 运行时，Windows/IDE 只使用服务目录本地依赖，兼容原有 IDE 配置且绝不跨平台回退。
- TS Agent 已验证：测试 33/33、type-check、build、start/healthz、JWT 鉴权、esbuild watch 自动重启均通过。
- 前端已通过 `paimeng-ai-code-mother-frontend/scripts/run.mjs` 和 `scripts/install-wsl-node-modules.sh` 迁移：WSL 实体依赖、Vite 缓存及构建产物位于 `wsl-rt-env/frontend/`；安装脚本通过 `npm --prefix` 直接安装到运行时目录。Windows/IDE 只使用服务目录本地 `node_modules`。
- Python RAG 已通过 `paimeng-ai-code-rag/scripts/install-wsl-venv.sh` 和 `scripts/run-wsl.sh` 迁移：WSL venv、uv 缓存和受 uv 管理的解释器位于 `wsl-rt-env/python/`；Windows 继续用默认 `.venv`。P4 前服务仍不常态运行。
- WSL 入口统一为项目内 shell 脚本：Java 使用根目录 `scripts/run-java-wsl.sh`；TS Agent、前端和 Python RAG 各自使用 `scripts/run-wsl.sh`；安装脚本也均为模块内 `scripts/*.sh`。所有 WSL 脚本先检查 Linux/WSL，Windows IDE 不调用它们。
- 验证已完成：Java 19/19 测试、TS Agent 33/33 测试与 type-check、前端 type-check/build、Python RAG 6/6 guardrail 测试均通过。

## Verification

- WSL 安装、启动与验证均通过项目内 `scripts/*.sh` 执行；Windows 首次使用对应服务时仍在服务目录安装本地平台依赖，无需改 IDE 配置。

## Authoritative References
- 总约定与常用命令：`AGENTS.md`
- 运行时布局、迁移待办、WSL/Windows 说明及踩坑：`.agents/memories/deployment.md`
- TS Agent 状态：`.agents/memories/ts-agent.md`
- TS Agent 代码：`paimeng-ai-code-agent/scripts/run.mjs`
- Java 构建目录属性：`pom.xml`
- 已完成提交：`85be778`

## Recommended Next Work
1. 按 P4 计划实施 Python RAG 业务能力；启动入口和 WSL 运行时路径已就绪。
2. Windows 首次使用任一 Node/Python 服务时在该服务目录安装本地平台依赖；无需改 IDE 配置。

## Suggested Skills
- `memory-management`: 迁移方案或踩坑产生可复用事实时更新项目记忆。
- `memory-quality-audit`: 修改或新增记忆文档后审查索引、事实和安全边界。
- `project-startup-guardrail`: 执行 WSL/Windows 启停和跨环境验证前调用。
- `project-comment-style`: 若需要新增或修改代码注释时调用。
- `code-review`: 若审查既有迁移提交或分支，而不是继续实现时调用。

## Safety
不要在交接文档或回复中写入任何 API key、密码、token 或本机个人敏感信息。不要回滚用户已有改动，不要删除未跟踪文件，除非用户明确要求。
