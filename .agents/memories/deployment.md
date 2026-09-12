# 记忆：运行与部署

> 环境依赖、敏感文件、共享工作区、启动命令的工作记忆。目标部署拓扑见 `docs/ts_agent/architecture.md` §1.1/§11；Python Agent 运行细节（退役前）见 `docs/py_agent/task_plan.md` §9（历史参考）。
> 存在三套本地环境：**原生 Linux 环境**（2026-09-07 起，当前宿主 Linux Mint 22.3，MySQL/Redis 经 docker compose 提供，默认使用）、**WSL 环境**（2026-09-01 起全栈实机验证通过，WSL 宿主时使用）与 **Windows 环境**（此前 T14a/T18/T20 实机验证所用，仍可用）。连接地址相同（127.0.0.1），不要混用同端口的多套实例。

## 运行时环境文件布局（2026-09-07 起按宿主分流；wsl-rt-env 仅限 WSL 宿主）

**2026-09-07 起（宿主换为原生 Linux）：原生 Linux 与 Windows/IDE 使用各服务默认运行环境目录（Java `target/`、Node `node_modules/`+`dist/`、Python `.venv/`）与标准命令，不指定环境输出目录；仅 WSL 宿主统一放仓库根目录 `wsl-rt-env/`（已加入根 .gitignore，2026-09-03）并通过命令指定。** 调度器判定标准（两个 `run.mjs` 一致，2026-09-07 修正）：`platform === 'linux'` 且 `/proc/version` 含 `microsoft` 才判为 WSL；原生 Linux 不含该标识，自动走默认目录（TS Agent 与前端 type-check/build 已实测通过，产物落在服务目录）。指向 WSL 运行时环境一律用命令参数（`-D` 属性 / 环境变量 / venv 直接调用）而非软链：

**下表为 WSL 宿主的 `wsl-rt-env/` 布局；原生 Linux / Windows 为默认布局，不使用该目录。**

| 技术栈 | 目标位置 | 说明 |
|---|---|---|
| Python | `wsl-rt-env/python/.venv` | uv 虚拟环境；`uv-cache/` 与 `python-install/` 同在该目录。WSL 执行 `bash paimeng-ai-code-rag/scripts/install-wsl-venv.sh` 创建；原生 Linux/Windows 仍使用服务目录 `.venv`。 |
| 前端 | `wsl-rt-env/frontend/node_modules` | WSL npm 依赖；Vite 缓存为 `wsl-rt-env/frontend/vite-cache`，构建产物为 `wsl-rt-env/frontend/dist`。`npm run` 经 `scripts/run.mjs` 按宿主调度：WSL 只读取该目录，原生 Linux/Windows 只读取服务目录本地 `node_modules`。 |
| Java | `wsl-rt-env/java/target` | Maven 构建产物；**2026-09-04 起由命令指定**：pom 暴露 `maven.build.directory` 属性（默认 `${project.basedir}/target`），WSL 命令带 `-Dmaven.build.directory=$PWD/wsl-rt-env/java/target`，无软链；原生 Linux/Windows 不传该属性即默认 `target/`。 |
| TS Agent | `wsl-rt-env/ts-agent/node_modules` + `wsl-rt-env/ts-agent/dist` | **2026-09-04 起完全无软链**：依赖与 esbuild 产物（`dist/app.bundle.mjs` 自包含打包，运行期不需要 node_modules）都在 wsl-rt-env；服务目录内不放 node_modules。`npm run dev/build/start/test/type-check` 经 `scripts/run.mjs` 按宿主选择：WSL 只使用 wsl-rt-env，原生 Linux/Windows 只使用服务目录本地依赖与 `dist/`。 |

> **迁移状态**：四个服务的 WSL 运行时路径、安装脚本与调度脚本均已就位（前端/TS Agent 经 `install-wsl-node-modules.sh` 用 `npm --prefix` 直装运行时目录，Python 经 `install-wsl-venv.sh` 用 uv 环境变量定向，均无软链）；Windows 与 WSL 平台相关依赖不共用，Windows 用各服务目录本地 `node_modules`/`.venv`，原有 IDE 运行配置无需改动。

## 依赖服务 — 原生 Linux 环境（当前宿主，2026-09-07 起）

- **MySQL + Redis + PostgreSQL（docker compose）**：仓库根 `docker-compose.yml`（项目名 `paimeng-infra`）。MySQL **8.0.46**（容器 `paimeng-mysql`，仅绑 127.0.0.1:3306，数据卷 `mysql-data`；首次启动自动执行 `sql/create_table.sql`）+ Redis **7.2**（容器 `paimeng-redis`，仅绑 127.0.0.1:6379，AOF 开启，数据卷 `redis-data`）+ PostgreSQL **pgvector/pgvector:pg16**（容器 `paimeng-postgres`，仅绑 127.0.0.1:5432，数据卷 `pg-data`，自动挂载 `sql/pg/init/`）。启动 `docker compose up -d`，三者均应 healthy。MySQL root 与 PostgreSQL 密码只放仓库根 `.env`（gitignore，勿提交勿外泄）。Docker 安装：`sudo bash scripts/install-docker.sh`。
- **本地库数据迁移（2026-09-08）**：`paimeng_ai_code_mother` 已导入用户提供的 Navicat 全量 dump `sql/paimeng_ai_code_mother.sql`（2026-09-06 导出，44 应用 / 156 对话 / 2 用户；有效账号 `paimeng666` 已充值 10000 积分）。⚠️ 该 dump 落后于 #10 积分体系：仅含 app/chat_history/user 三表且 user 无 `credits` 列——**每次重新导入后必须补 `ALTER TABLE user ADD COLUMN credits int NOT NULL DEFAULT 0`**（与 `sql/create_table.sql` 定义一致；credit_ledger/generation_run 不在 dump 内、不被 DROP，但需自行 TRUNCATE 旧测试残留）。导入：`docker exec -i paimeng-mysql mysql -uroot -p<pwd> paimeng_ai_code_mother < sql/paimeng_ai_code_mother.sql`。0907 建库时的 e2e 测试用户（id 454742734167748608）已随覆盖消失，依赖它的脚本需改注册新用户。
- **Nginx（docker compose，2026-09-08 新增）**：容器 `paimeng-nginx`（nginx:alpine），仅绑 127.0.0.1:80，承担**部署产物静态路由**——访问 URL `http://localhost/{deployKey}`（与 Java `AppConstant.CODE_DEPLOY_HOST`、前端 `VITE_DEPLOY_DOMAIN=http://localhost` 一致），产物根只读挂载宿主 `tmp/code_deploy`（Java 部署写入方，目录内 `.gitkeep` 入库防新克隆时 compose 先建 root 属主目录）；配置 `docker/nginx/deploy.conf`，探活 `/healthz`。宿主 80 原被无业务的 Ubuntu Apache 默认页占用（apache2 服务 active+enabled），2026-09-08 用户执行 `systemctl disable --now apache2` 停用让位（勿再装回或启用）。生产等价路由模板见 `deploy/nginx.conf.example`。
- **SearXNG（docker compose，2026-09-07 新增）**：容器 `paimeng-searxng`，仅绑 127.0.0.1:**8888**（宿主机端口避开 Tomcat/Spring Boot 默认的 8080；容器内部仍监听 8080，由端口映射转换），配置 `docker/searxng/settings.yml` 挂载为 `/etc/searxng/settings.yml`（`use_default_settings` 合并 + `search.formats` 开 `json`；境内不可达的 google/duckduckgo/qwant 图片引擎已显式禁用，`limiter: false` 单机免限流）。用途：全网热词图片搜索源（Java 侧 `WebImageSearchTool` 已随 T21 删除，能力归 TS Agent `src/generation/tools/imageTools.ts`）；探活 `curl http://127.0.0.1:8888/healthz`，图片搜索自测 `curl 'http://127.0.0.1:8888/search?q=原神&categories=images&format=json'`。

## 依赖服务 — WSL 环境（WSL 宿主适用，2026-09-01 全栈验证）

- **灰度状态（2026-09-08 #14 收官）**：`ts-agent.enabled` 默认 **true**（`application.yml` 仓库默认 `${TS_AGENT_ENABLED:true}`），唯一门禁点 `GET /app/agent/token`（关闭→40410）；旧 Java AI 链路已按 T21 删除，`python-agent.*`/`agent.*` 配置段与环境变量（`PYTHON_AGENT_ENABLED`/`AGENT_*`）全部退役，现行为 `ts-agent.*`/`TS_AGENT_*`（模板 `application-local.yml.example` 在档）。回退手段 = git 回滚。

- **MySQL**：用户态安装 `~/.local/opt/mysql8`（8.0.46，tarball 解包，非系统服务）。启动 `bash ~/.local/opt/mysql8/start.sh`（监听 0.0.0.0:3306，socket `/tmp/mysql-zdan.sock`，日志 `~/.local/opt/mysql8/mysqld.log`，stop 用同目录 `mysqladmin --socket=/tmp/mysql-zdan.sock shutdown`，密码见 `application.yml` 数据源）。库 `paimeng_ai_code_mother` 已按 `sql/create_table.sql` 建表（user/app/chat_history）；另有课程模块的 `course_dev` 库。**Windows IDE 直连**（2026-09-01 实测）：Host = WSL IP（`hostname -I`，重启可能漂移）、Port 3306、账号见 `application.yml`；bind 0.0.0.0 仅暴露给 WSL NAT 内网，局域网不可达。
- **Redis**：WSL 内源码编译运行（`./src/redis-server *:6379`，无密码）。**2026-09-04 实测：此前源码编译产物已不在 WSL**（Java 后端启动即连 Redisson 会失败），当日为验证 #4 重新源码编译并固化到 `~/.local/opt/redis-7.2.5/`（启动：`~/.local/opt/redis-7.2.5/src/redis-server --port 6379 --daemonize no`）；apt 装 redis-server 需密码，故源码编译为准。
- **Java 内部 API 服务令牌**：`internal-api.token`（`application.yml` 默认 `${INTERNAL_API_TOKEN:}`，本地 `application-local.yml` 为 `dev-token`，与 TS Agent 侧 `JAVA_INTERNAL_TOKEN` 一致；TS Agent `.env.example` 已加 `JAVA_INTERNAL_BASE_URL=http://localhost:8123/api` + `JAVA_INTERNAL_TOKEN=dev-token`）。
- **PostgreSQL**：由根目录 compose 提供 `paimeng-postgres`（`pgvector/pgvector:pg16`，仅绑定 `127.0.0.1:5432`，数据卷 `pg-data`，初始化挂载 `sql/pg/init/`）。会话事件表 `session_event` 是 TS Agent 的运行时强依赖；RAG v2 复用同一实例并使用独立数据库。启动 `docker compose up -d postgres`，探活 `docker compose ps postgres` 应为 `healthy`，客户端检查使用 `pg_isready -h 127.0.0.1 -p 5432 -U postgres -d paimeng`。

## 依赖服务 — Windows 环境（此前实机验证所用）

- **MySQL**：Windows 服务 `MySQL80`（8.0.36，监听 3306）。root 账号仅 Windows 本机可达（账号密码见 `application.yml` 本地值）；WSL2 NAT 下 WSL→Windows 无 localhost 转发，直连需网关 IP + 专用账号（未采用，用户决策统一走 WSL 侧）。
- **Redis**：Docker Desktop 容器（7.2.5，Windows 侧 6379 由 Docker backend 代理）。

## 敏感文件（不提交）

- `src/main/resources/application-local.yml`（gitignore；参考 `application.yml`，填 API keys）。
- Python 侧 `.env`：现位于 `paimeng-ai-code-rag/.env`（退役 Agent 遗留，含联调密钥，gitignore 不提交；P4 RAG 实施时按新 `.env.example` 重建）；TS Agent 侧 `.env` 在 `paimeng-ai-code-agent/`（同规则）。

## 共享工作区

- `tmp/code_output/{codeGenType}_{appId}`；Java `CODE_OUTPUT_ROOT_DIR = user.dir/tmp/code_output`，TS Agent 侧 `WORKSPACE_ROOT` 须为同一绝对路径（Java 计算绝对路径传入，Agent 侧沙箱校验）。
- 本地同机；生产同容器卷或共享卷挂载。

## 启动命令（按宿主选择）

### 原生 Linux（当前宿主，2026-09-07 实测依赖安装/type-check/build）

| 项 | 命令 |
|---|---|
| MySQL/Redis/SearXNG/Nginx | `docker compose up -d`（首次启动自动建库建表；探活 `docker compose ps`；SearXNG 健康检查 `/healthz`；nginx 挂 `docker/nginx/deploy.conf`，部署应用访问 `http://localhost/{deployKey}`） |
| Java | `JAVA_HOME=<JDK21 路径> ./mvnw spring-boot:run`（默认 `target/`，无需 `-D`；端口 8123，context-path `/api`。**不要用 `scripts/run-java-wsl.sh`**——它会把产物写进 `wsl-rt-env/`） |
| TS Agent 安装依赖 | `cd paimeng-ai-code-agent && npm install --registry=https://registry.npmmirror.com`（DSH 沙箱内加 `--cache ../tmp/npm-cache`） |
| TS Agent 运行 | `cd paimeng-ai-code-agent && npm run dev`（端口 8092；bundle 在服务目录 `dist/`） |
| 前端安装依赖 | `cd paimeng-ai-code-mother-frontend && npm install --registry=https://registry.npmmirror.com`（缓存参数同上） |
| 前端运行 | `cd paimeng-ai-code-mother-frontend && npm run dev`（5173；type-check/build 走本地 `node_modules` 与 `tsconfig.json`） |
| Python RAG（P4 前） | 不安装不启动；P4 实施后用 uv 默认 `.venv` 的标准命令，不用 `*-wsl.sh` |

### WSL 宿主（2026-09-01 全链路验证）

> 完整启动 SOP 与排障护栏见技能 `project-startup-guardrail`（`.agents/skills/project-startup-guardrail/SKILL.md`）。

| 项 | 命令 |
|---|---|
| MySQL（如未启动） | `bash ~/.local/opt/mysql8/start.sh`（需 DSH 提权，见踩坑） |
| Java（WSL） | `bash scripts/run-java-wsl.sh`（端口 8123，context-path `/api`；API 文档 `http://localhost:8123/api/doc.html`；构建产物在 `wsl-rt-env/java/target`） |
| TS Agent 安装依赖 | `cd paimeng-ai-code-agent && bash scripts/install-wsl-node-modules.sh`（脚本通过 `npm --prefix` 直接安装至 `wsl-rt-env/ts-agent/`；勿用 `npm ci`） |
| TS Agent 运行 | `cd paimeng-ai-code-agent && bash scripts/run-wsl.sh`（端口 8092；esbuild 打包到 `wsl-rt-env/ts-agent/dist/app.bundle.mjs` 后运行） |
| Python RAG（P4 未实施） | `cd paimeng-ai-code-rag && bash scripts/install-wsl-venv.sh`；P4 实施后运行 `bash scripts/run-wsl.sh serve`（8091）。当前退役骨架不常态启动。 |
| 前端 WSL 安装依赖 | `cd paimeng-ai-code-mother-frontend && bash scripts/install-wsl-node-modules.sh`（脚本通过 `npm --prefix` 直接安装至 `wsl-rt-env/frontend/`） |
| 前端 | `cd paimeng-ai-code-mother-frontend && bash scripts/run-wsl.sh`（调度器使用 `wsl-rt-env/frontend/node_modules` 与 `vite-cache`、`dist`） |

## 踩坑与规避（按宿主与沙箱环境）

- **compose 端口绑定失败的残留容器（2026-09-08 实测）**：`docker compose up -d <svc>` 因宿主端口被占失败后，容器对象保留无端口绑定的中间态；释放端口后重新 `up` 只会 Start 残留容器（`docker port` 为空、宿主无监听）——必须 `docker compose up -d --force-recreate <svc>` 才恢复端口映射。
- **运行时目录按宿主分流（2026-09-07）**：下文旧条目中「WSL/Linux 只使用 wsl-rt-env」自当日起仅指 **WSL 宿主**（判定 `platform === 'linux'` 且 `/proc/version` 含 `microsoft`）；原生 Linux 宿主一律默认目录 + 标准命令，详见本文件开头 §布局。
- **npm 官方源不可达 + 家目录写被拦（原生 Linux，2026-09-07 实测）**：`registry.npmjs.org` 网络不通，安装加 `--registry=https://registry.npmmirror.com`；`~/.npm` 缓存写入被 DSH 沙箱 workspace-write 拦截，加 `--cache <仓库>/tmp/npm-cache`。
- **Docker Hub 拉取超时（原生 Linux，2026-09-07 实测）**：`auth.docker.io` 匿名 token 请求 EOF（境内网络），`docker pull` 直连失败。规避：`docker pull docker.m.daocloud.io/searxng/searxng:latest` 后 `docker tag` 回原名；或为 daemon 配置 registry-mirrors（需 root，未做）。
- **DSH 沙箱 workspace-write 拦家目录写**：mysqld 需写 `~/.local/opt/mysql8`（data/log/pid），start.sh 须以完整权限运行；`./mvnw spring-boot:run` 同理会写 `~/.m2/repository`（resolver-status.properties），亦须完整权限（2026-09-03 P0 e2e 实测）；`uv run` 因 `~/.cache/uv` 被拒时，使用 `bash paimeng-ai-code-rag/scripts/run-wsl.sh`；npm 安装脚本已将缓存直接写入各自的 `wsl-rt-env/<service>/npm-cache`。
- **WSL 安装/启动脚本机制（2026-09-04）**：安装入口——TS Agent 与前端各自 `bash scripts/install-wsl-node-modules.sh`（复制受版本控制的 package.json/package-lock.json 后以 `npm --prefix wsl-rt-env/<svc> install` 直装实体目录，不创建软链、不在服务目录暂存依赖）、Python RAG `bash scripts/install-wsl-venv.sh`（`UV_PROJECT_ENVIRONMENT`/`UV_CACHE_DIR`/`UV_PYTHON_INSTALL_DIR` 定向 `wsl-rt-env/python/`，Windows 用 uv 默认本地 `.venv`）。启动入口——Java 根目录 `scripts/run-java-wsl.sh`（`run`/`test`/`compile`），TS Agent/前端/Python 各自 `scripts/run-wsl.sh`（npm 子命令可传）；全部脚本先校验 Linux/WSL 再指向 `wsl-rt-env/`，不影响现有 IDE 配置。
- **npm 会替换 node_modules 符号链接（TS Agent，2026-09-04 已根治）**：旧方案服务目录放符号链接，`npm install`/`npm ci` 的 reify 都会把它换成实体目录。现方案 esbuild 打包改造后**服务目录零 node_modules、零软链**：WSL 安装命令为 `bash scripts/install-wsl-node-modules.sh`，脚本通过 `npm --prefix wsl-rt-env/ts-agent install` 直接写入运行时目录；运行/测试经 `scripts/run.mjs` 按平台调度，绝不跨平台回退。
- **TS Agent 无软链方案的工具适配（2026-09-04 实测踩坑）**：① Node ESM 不认 NODE_PATH，vitest 靠 `vitest.config.mjs` 的 `resolve.alias` 指向 `wsl-rt-env/ts-agent/node_modules`（alias 必须写在服务目录内的配置里，配置文件里 `new URL('../wsl-rt-env/...')` 的相对解析以配置文件自身位置为基准）；② tsc 不认 NODE_PATH，`tsconfig.json` 用 `paths` 显式映射到各包 d.ts **文件**（映射到目录无效，NodeNext 下不做 package.json 解析）+ `typeRoots` 双候选，候选列表本地优先、wsl-rt-env 兜底；③ esbuild JS API 不读 NODE_PATH（CLI 才读），等价物是 `nodePaths` 选项；`bin/esbuild` 可能被 postinstall 换成原生 ELF，勿用 `node bin/esbuild` 调用，走 `lib/main.js` 的 JS API；④ esbuild ESM bundle 需 banner 注入 `createRequire`（fastify 内部有 CJS require），CJS 格式则挂 `import.meta.url`；⑤ DrvFs 上 `node --watch` 收不到文件事件（esbuild 自带轮询兜底可收到），dev 的重启链路由 esbuild watch 的 `onEnd` 回调驱动，不用 node --watch。
- **DrvFs 目录重命名受限**：/mnt/c 上 mv 含打开句柄的目录（如运行中的 tsx watch 占用 node_modules）报 Permission denied——先停相关进程再迁移。
- **WSL2 NAT 无 localhost 转发**：Java 配置 `localhost:3306/6379` 只解析到 WSL 内实例；连 Windows 侧实例需网关 IP（`ip route show default`）。

## 健康检查

- `GET http://localhost:8092/healthz` → 200 `{"status":"ok"}`（TS Agent，#3 骨架起）。
- 旧 Python Agent 8090 不再运行（代码在 `paimeng-ai-code-rag/` 退役暂存）。
- 全栈：`doc.html` 200 + `8092/healthz` ok + 前端 5173 200 + `ss -tlnp` 见 3306/6379/5432/80 监听（PostgreSQL 由 compose 提供）；部署产物冒烟 `curl -o /dev/null -w "%{http_code}" http://localhost/{deployKey}/` → 200。
- **生产目标拓扑**（见 `docs/ts_agent/architecture.md` §1.1）：nginx 单域名路由 `/api/*`→Java(8123)、`/agent/*`→TS Agent(Node)；RAG 仅内网。**配置模板已就位（#12）**：`deploy/nginx.conf.example`（/agent 段含 SSE 关键配置：`proxy_buffering off` + `proxy_read_timeout 600s` + HTTP/1.1 空 Connection）。
