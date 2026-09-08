# 项目记忆（MEMORY）

> 本文件是**总入口**：一句话现状 + 指向领域记忆。详细记忆在 `.agents/memories/`（见下）。
> 长期权威文档（设计、契约、验收）在 `docs/`。

## 一句话现状

**2026-09-03 架构定稿（经四轮设计审讯确认）：Java（业务/鉴权/积分/历史/构建）+ TS Agent（`paimeng-ai-code-agent/`，Node/Fastify + Vercel AI SDK + XState v5，前端 fetch-SSE 直连 + JWT）+ Python RAG（`paimeng-ai-code-rag/`，day-1 只读 few-shot 检索）三服务**；权威设计 `docs/ts_agent/architecture.md`。Python Agent（T0-T20 曾实机验证但未上生产）**全面退役**：回切旧 Java AI 兜底、T21 门禁重定向为"TS Agent 契约对等 + 回归全绿"、PG 停用；**其目录已整体重命名为 `paimeng-ai-code-rag/`（2026-09-03 用户决策，取代"新建后删除"），TS Agent 落位 `paimeng-ai-code-agent/`（目录名复用）；python-agent 领域记忆已删除，重构为 ts-agent / python-rag 两域**。`docs/py_agent/` 转历史参考。**实施已启动（2026-09-03）**：**P0 已执行完毕并本地 e2e 验证**（Issue #2）→ **P1 骨架完成（Issue #3，TS Agent 服务已可运行并 curl 实测）** → **#4 run 生命周期完成（generation_run DDL + Java 内部 run API + Agent run 客户端 + 409 并发拒绝，2026-09-04）** → **#5 最小生成流+契约定稿已完成（2026-09-04，XState v5 + Vercel AI SDK 重做定稿）** → **#6 Agent→Java 回调打通已完成（2026-09-04：Java `ai/python/*` 泛化为 `ai/agent/*`，`agent.*` 配置段 + `python-agent.*` 别名保留；新增完成回调 `POST /internal/agent/runs/{runId}/complete` 写对话历史 + 触发构建，Bearer 401 + runId 幂等；TS Agent `completeRun` 客户端 + workflow 终态回调；WSL e2e 验收落库/产物/幂等/401 全通过，回退链路行为不变）** → **#7 需求工程已完成（2026-09-04：TS Agent 五维访谈（每维 2-4 选项选择题、≤2 轮、信息足够跳过）+ 免费线框（单文件 HTML 含站点地图、≤5 页、落工作区 wireframe/、快速档）+ wireframe_pending 跨请求持久化 + codegen 闸门（未确认线框拒绝，明确报错）+ 线框每日配额内部端点（复用 Redisson 限流机制，超限 429）；TS 48/48、Java 35/35，WSL e2e 两次独立会话全链路验收通过）** → **#8 生成核心移植已完成（Guardrail/解析/文件六工具/图片四工具+配额/提示词 7 份/10 工具注册；TS 85/85）** → **#12 前端通道切换已完成（2026-09-04：Java 登录态签发短时 JWT + 前端 fetch-SSE 直连 Agent + 七类事件渲染 + vite/nginx 路由；e2e 全链路验证）** → **#9 质检门禁+护栏+三档+token 计量已完成（2026-09-05：三工位循环 + 三重门禁（质检分/build/视觉 diff 以已确认线框为基准）+ 质检失败有界重试（先例 2 次）+ 护栏前三层（max_turns/max_output_tokens/max_tool_calls=50/图片 4 张随三档强度缩放，超限优雅收尾绝不硬杀）+ 输入历史滑窗 + token 计量按 run 落库；TS 128/128，code-review 双轴整改闭环）** → **#10 积分协议已完成（2026-09-05：credit_ledger 三态台账（冻结→结算/部分退款/全额退款，uk_runId 幂等，同库同事务）+ user.credits 余额 + 管理员充值 + 冻结时点=确认线框进入 codegen（余额不足 402 拒绝）+ completeRun 三剧本记账（run 终态与台账一致）+ 对话中断（连接断开感知→取消 LLM→保留已写文件→历史 [用户中断]→按里程碑折算退款，首文件落盘前全额退）；TS 137/137 + Java 相关 70/70 + 全量对比基线无回归 + WSL e2e 五剧本验收（完成/失败/中断已写文件/中断首文件前/余额不足/幂等）；**交付后补跑 code-review 双轴审查并整改闭环（并发双重退款→DB 原子 SQL+台账条件更新、AC5 迟到回调防护、强度/reason 魔法值枚举化、review 工位 LLM 取消全覆盖、filesWritten 改落盘文件数去重语义；Java 相关 77/77 + TS 139/139 + WSL 实库并发/迟到/幂等验证）**）** → P2 核心能力收尾（#9/#10 已完）→ P3 剩余（#13 前端功能补齐、#11 对账、#14 灰度+T21）→ P4 RAG+盈利 MVP（手动充值已就绪；无执照，微信支付/公众号通知 v1.x）。本地环境：WSL 全栈（MySQL 8.0.46 + Redis 源码编译；PG16 已停用、5432 无监听），运行时环境文件约定 `wsl-rt-env/`（**2026-09-04：Java `target` 已迁入 `wsl-rt-env/java/target`（`-Dmaven.build.directory` 指定）；TS Agent esbuild 打包改造完成（依赖/产物在 `wsl-rt-env/ts-agent/`，服务目录零 node_modules、零软链，npm scripts 经 `scripts/run.mjs` 指向）**；前端依赖/Vite 缓存已迁入 `wsl-rt-env/frontend/`，Python RAG 的 venv/uv 缓存/解释器已由 WSL 脚本定向到 `wsl-rt-env/python/`；Windows/IDE 只使用服务目录本地依赖，调度器绝不跨平台回退，原有运行配置不变）。**2026-09-07：宿主迁移为原生 Linux Mint 22.3**——运行时环境改为按宿主分流（原生 Linux/Windows 用各服务默认目录与标准命令，不指定环境输出目录；`wsl-rt-env/` 仅限 WSL 宿主；两个 `scripts/run.mjs` 的 WSL 判定改为 `/proc/version` 含 `microsoft`，TS Agent 与前端 type-check/build 已在新宿主实测通过）；MySQL/Redis 迁 docker compose（根 `docker-compose.yml`：MySQL 8.0.46 + Redis 7.2，仅绑 127.0.0.1，首次启动自动建库建表；Docker 安装脚本 `scripts/install-docker.sh` 待用户执行后验证），权威约定见 `deployment.md` 与启动 SOP。**2026-09-07 双源图片搜索落地**：compose 新增 SearXNG 自建聚合搜索（`paimeng-searxng`，127.0.0.1:8888，端口避开 Tomcat 默认 8080，JSON API）；Java 新增 `WebImageSearchTool.searchWebImages`（全网热词，版权不确定仅预览）与既有 Pexels 素材库工具切分并存，规划提示词双源路由；原神端到端实测通过；顺带修复 `AiCodeGenServiceFactory` 弃用注入导致的上下文启动失败（详见 `java-backend.md`）。**2026-09-07 #11 对账审计与推翻记录**：基于 2026-09-06 clone（当时远程 main 停在 #6）曾判定 #7/#8/#9/#10/#12 五票「幻影关闭」（原审计提交 8a16cf7，报告 `docs/ts_agent/contract-parity.md`）；经用户指正，实现提交一直在远程仓库（本地未 fetch 到），已合流入 main——**「幻影关闭」结论作废**；84 例清点表仍有效，但覆盖/缺口判定基于 TS 37/37 旧基线，#11 对账须基于真实实现重跑修正。

## 领域记忆（`.agents/memories/`）

| 文档 | 内容 |
|---|---|
| `README.md` | 记忆目录索引与更新约定 |
| `architecture.md` | 三服务目标架构决策（拓扑/鉴权/数据分工/护栏/闸门）、过渡态 |
| `java-backend.md` | Java 侧状态、编译红线、迁移残留、关键事实 |
| `ts-agent.md` | TS Agent（`paimeng-ai-code-agent/`）实施状态、移植参考清单、契约教训 |
| `python-rag.md` | Python RAG（`paimeng-ai-code-rag/`，P4）：目录来历、可复用骨架、day-1 结论 |
| `vue-frontend.md` | 前端约定、SSE 消费基线、P3 计划改造 |
| `deployment.md` | 环境依赖（WSL 默认 / Windows 两套）、运行时环境布局、敏感文件、共享工作区、启动命令 |

## 权威文档

- `docs/ts_agent/architecture.md`：**目标架构权威设计**（三服务/新 SSE 协议要点/run 表/护栏/计费/RAG/退役/实施顺序）
- `docs/ts_agent/contract.md`：TS Agent 浏览器 wire 契约（**#5 已定稿**）
- `docs/py_agent/task_plan.md`：Java↔Python 契约与任务（**历史参考**，TS 移植参考源）
- `docs/py_agent/progress.md`：Python Agent 进度日志（历史，含退役决策记录）
- `CONTEXT.md`：项目领域上下文与架构分层
- `AGENTS.md`：Agent 项目约定与任务资料路由

## 下一步

按 `docs/ts_agent/architecture.md` §11 执行：P0（#2）、P1（#3/#4/#5/#6）、P2（#7/#8/#9/#10）均已完成，#12 前端通道切换已完成（Java JWT 签发 + 前端 fetch-SSE + 七类事件渲染）。**#11 契约对账已完成（2026-09-07）**：84 例逐文件对账（72 覆盖 / 3 语义差异 / 9 有意演进），缺口补齐 5 项（golden e2e×2、工具名契约、拼接、回调容错），`npm test` **144/144**，对等报告终稿 `docs/ts_agent/contract-parity.md`（T21「契约对等」判据**通过**，附 P3 修正项 5 条）。**当前进行 #13 前端功能补齐：线框确认 UI + 档位选择器 + 中止按钮 + 积分显示 + L1 mock 预览** → #14 灰度+T21。实施进度日志：`docs/ts_agent/progress.md`。每完成一个任务：更新 `.agents/memories/` 对应文档 + 在 `docs/ts_agent/progress.md` 追加一行（含日期与命令证据）。
