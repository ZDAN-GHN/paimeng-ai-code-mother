# 记忆：运行与部署

> 环境依赖、敏感文件、共享工作区、启动命令的工作记忆。目标部署拓扑见 `docs/ts_agent/architecture.md` §1.1/§11；Python Agent 运行细节（退役前）见 `docs/py_agent/task_plan.md` §9（历史参考）。
> 存在两套本地环境：**WSL 环境**（2026-09-01 起，全栈实机验证通过，默认使用）与 **Windows 环境**（此前 T14a/T18/T20 实机验证所用，仍可用）。二者连接地址相同（127.0.0.1），不要混用同端口的两套实例。

## 运行时环境文件布局（wsl-rt-env，2026-09-01 新约定）

整个项目在 Linux/WSL 运行的运行时环境文件统一放仓库根目录 `wsl-rt-env/`（已加入根 .gitignore，2026-09-03）：

| 技术栈 | 目标位置 | 说明 |
|---|---|---|
| Python | `wsl-rt-env/python/.venv` | uv 虚拟环境（替代旧 `.venv-wsl`） |
| 前端 | `wsl-rt-env/frontend/node_modules` | npm 依赖 |
| Java | `wsl-rt-env/java/target` | Maven 构建产物 |
| TS Agent | `wsl-rt-env/ts-agent/node_modules` + `wsl-rt-env/ts-agent/dist` | **2026-09-03 起新服务直接按约定就位**：服务目录内 `paimeng-ai-code-agent/node_modules` 为指向它的符号链接，命令不变 |

> **迁移待办**：TS Agent 已合规（node_modules/dist 均在 `wsl-rt-env/ts-agent/`）；存量 `.venv`（`paimeng-ai-code-rag/`，退役代码遗留）、`node_modules`（`paimeng-ai-code-mother-frontend/`）、`target`（仓库根目录）尚未迁入。迁移完成前，存量启动命令按实际路径执行；旧 `.venv-wsl` 已不再使用。

## 依赖服务 — WSL 环境（当前默认）

- **灰度状态（2026-09-03 P0 已执行，Issue #2）**：`application-local.yml` 已回切 `python-agent.enabled: false`（过渡期主链路 = 旧 Java AI，当日 WSL 全栈 e2e 全流程验证通过：建应用 → SSE 生成 → 构建 → 部署）；`application.yml` 仓库默认为 `${PYTHON_AGENT_ENABLED:false}`；TS Agent 接入后再新增 `ts-agent.enabled` 灰度。

- **MySQL**：用户态安装 `~/.local/opt/mysql8`（8.0.46，tarball 解包，非系统服务）。启动 `bash ~/.local/opt/mysql8/start.sh`（监听 0.0.0.0:3306，socket `/tmp/mysql-zdan.sock`，日志 `~/.local/opt/mysql8/mysqld.log`，stop 用同目录 `mysqladmin -uroot -proot --socket=/tmp/mysql-zdan.sock shutdown`）。root 密码 2026-09-01 由空改为 `root`（与 `application.yml` 数据源一致，start.sh 已同步）。库 `paimeng_ai_code_mother` 已按 `sql/create_table.sql` 建表（user/app/chat_history）；另有课程模块的 `course_dev` 库。**Windows IDE 直连**（2026-09-01 实测）：Host = WSL IP（`hostname -I`，重启可能漂移）、Port 3306、账号 `root`（`root@'172.31.%'`）/root；bind 0.0.0.0 仅暴露给 WSL NAT 内网，局域网不可达。
- **Redis**：WSL 内源码编译运行（`./src/redis-server *:6379`，无密码）。
- **PostgreSQL**：用户态 PG16 @ 127.0.0.1:5432（清华镜像 deb 解包 + `LD_LIBRARY_PATH`），原仅存 LangGraph checkpoint。**已停用（2026-09-03 P0 执行确认）**：checkpoint 职责随 Python Agent 退役消失，`generation_run` 落 MySQL；现状为无服务、无容器自启机制、5432 无监听（用户态安装保留），RAG v2（pgvector）时按本 runbook 重启。

## 依赖服务 — Windows 环境（此前实机验证所用）

- **MySQL**：Windows 服务 `MySQL80`（8.0.36，监听 3306）。root/root 仅 Windows 本机可达；WSL2 NAT 下 WSL→Windows 无 localhost 转发，直连需网关 IP + 专用账号（未采用，用户决策统一走 WSL 侧）。
- **Redis**：Docker Desktop 容器（7.2.5，Windows 侧 6379 由 Docker backend 代理）。

## 敏感文件（不提交）

- `src/main/resources/application-local.yml`（gitignore；参考 `application.yml`，填 API keys）。
- Python 侧 `.env`：现位于 `paimeng-ai-code-rag/.env`（退役 Agent 遗留，含联调密钥，gitignore 不提交；P4 RAG 实施时按新 `.env.example` 重建）；TS Agent 侧 `.env` 在 `paimeng-ai-code-agent/`（同规则）。

## 共享工作区

- `tmp/code_output/{codeGenType}_{appId}`；Java `CODE_OUTPUT_ROOT_DIR = user.dir/tmp/code_output`，TS Agent 侧 `WORKSPACE_ROOT` 须为同一绝对路径（Java 计算绝对路径传入，Agent 侧沙箱校验）。
- 本地同机；生产同容器卷或共享卷挂载。

## 启动命令（WSL 环境，2026-09-01 全链路验证）

> 完整启动 SOP 与排障护栏见技能 `project-startup-guardrail`（`.agents/skills/project-startup-guardrail/SKILL.md`）。

| 项 | 命令 |
|---|---|
| MySQL（如未启动） | `bash ~/.local/opt/mysql8/start.sh`（需 DSH 提权，见踩坑） |
| Java | `./mvnw spring-boot:run`（端口 8123，context-path `/api`；API 文档 `http://localhost:8123/api/doc.html`） |
| Python RAG（P4 未实施） | `paimeng-ai-code-rag/` 为旧 Python Agent 重命名（骨架复用起点），退役代码不常态运行，不占用 8090 |
| TS Agent | `cd paimeng-ai-code-agent && npm run dev`（端口 8092；node_modules 实际位于 `wsl-rt-env/ts-agent/node_modules`，服务目录内为符号链接，命令不变） |
| 前端 | `cd paimeng-ai-code-mother-frontend && npm run dev`（WSL 首次需补 Linux 二进制，见踩坑） |

## 踩坑与规避（WSL + DSH 沙箱环境）

- **DSH 沙箱 workspace-write 拦家目录写**：mysqld 需写 `~/.local/opt/mysql8`（data/log/pid），start.sh 须以完整权限运行；`./mvnw spring-boot:run` 同理会写 `~/.m2/repository`（resolver-status.properties），亦须完整权限（2026-09-03 P0 e2e 实测）；`uv run` 因 `~/.cache/uv` 被拒 → 直接调 `.venv/bin/uvicorn`（迁移后 `wsl-rt-env/python/.venv/bin/uvicorn`）；npm 缓存被拒 → 加 `--cache <repo>/tmp/npm-cache`。
- **前端 node_modules 为 Windows 侧安装**（仅 win32 二进制）：WSL 跑 `npm run dev` 前补装 `npm i --no-save --cache <repo>/tmp/npm-cache @rollup/rollup-linux-x64-gnu @esbuild/linux-x64`；重装 node_modules 后需重做。新约定 node_modules 位于 `wsl-rt-env/frontend/node_modules`（待迁移）。
- **npm ci 与 node_modules 符号链接（TS Agent）**：`npm ci` 会先删除 node_modules（即删掉符号链接本身再建实体目录），破坏 wsl-rt-env 布局——一律用 `npm install`；误删后重建：`mv node_modules wsl-rt-env/ts-agent/ && cd .. && ln -s wsl-rt-env/ts-agent/node_modules paimeng-ai-code-agent/node_modules`（对齐 gitignore 后无痕）。
- **DrvFs 目录重命名受限**：/mnt/c 上 mv 含打开句柄的目录（如运行中的 tsx watch 占用 node_modules）报 Permission denied——先停相关进程再迁移。
- **WSL2 NAT 无 localhost 转发**：Java 配置 `localhost:3306/6379` 只解析到 WSL 内实例；连 Windows 侧实例需网关 IP（`ip route show default`）。

## 健康检查

- `GET http://localhost:8092/healthz` → 200 `{"status":"ok"}`（TS Agent，#3 骨架起）。
- 旧 Python Agent 8090 不再运行（代码在 `paimeng-ai-code-rag/` 退役暂存）。
- 全栈：`doc.html` 200 + `8092/healthz` ok + 前端 5173 200 + `ss -tlnp` 见 3306/6379 监听（**5432 停用后不应出现**）。
- **生产目标拓扑**（见 `docs/ts_agent/architecture.md` §1.1）：nginx 单域名路由 `/api/*`→Java(8123)、`/agent/*`→TS Agent(Node)；RAG 仅内网。
