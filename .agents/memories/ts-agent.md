# 记忆：TS Agent（Node，`paimeng-ai-code-agent/`）

> 目标架构与实施顺序权威：`docs/ts_agent/architecture.md`；wire 契约（#5 定稿）：`docs/ts_agent/contract.md`。本文件只记实施状态、决策摘要与移植指针。

## 当前状态

- **2026-09-03 用户决策：目录名复用 `paimeng-ai-code-agent/`**（旧 Python Agent 目录已整体重命名为 `paimeng-ai-code-rag/`，见 `python-rag.md`）。
- **骨架已完成（Issue #3，2026-09-03）**：Fastify 5 + TypeScript 5.9 + jose 6 + vitest 3，端口 8092；`npm test` 24/24 全绿（鉴权 401 矩阵×7、沙箱逃逸×9、SSE 顺序/格式×7）；type-check 通过。
- **run 客户端已完成（Issue #4，2026-09-04）**：`src/internal/runClient.ts`（Java 内部 API：createRun/updateRun/getRun/getLatestNonTerminalRun，Bearer 服务令牌 + JSON；409→`RunConflictError`「当前有进行中的任务」、401→`RunApiError`、网络失败→status 0）；配置新增 `JAVA_INTERNAL_BASE_URL`（默认 `http://localhost:8123/api`，含 context-path）与 `JAVA_INTERNAL_TOKEN`（与 Java 侧 `internal-api.token` 一致，.env.example 已加）；`npm test` 33/33（原 24 + run-client 9）。
- 路由：`GET /healthz`（无鉴权）、`POST /agent/workspace/validate`、`GET /agent/smoke/sse`（均 JWT 保护，钩子封装在插件作用域不外溢）。
- JWT 约定：HS256 共享密钥（`JWT_SECRET`），`algorithms` 白名单防混淆，`requiredClaims: ['exp','sub']`，离线验签不回查 Java；Java 侧签发在 #12。
- `WORKSPACE_ROOT` 默认按服务目录解析 `../tmp/code_output`（对齐 Java `user.dir/tmp/code_output`），沙箱校验含 realpath 符号链接消解（移植 manager.py）。
- 测试基建约定（后续票据沿用）：真实服务实例（`buildApp(overrides)`）+ `fastify.inject()` 注入式请求 + `jose SignJWT` 自签（`test/helpers.ts`）。
- 运行时环境布局（2026-09-03 起）：node_modules 物理位于 `wsl-rt-env/ts-agent/node_modules`（服务目录内为符号链接），构建产物 `wsl-rt-env/ts-agent/dist`（`npm run build`）。**npm install 会把符号链接替换回实体目录**——安装命令必须以 `bash scripts/sync-node-modules.sh` 归位收尾；`npm run dev`/`npm test` 不受影响。
- 实施票据链：~~#3 骨架~~ → ~~#4 run 生命周期~~ → #5 最小生成流 + 契约定稿 → #6 回调打通 → #7-#9 核心能力 → #10 积分 → #11 对账 → #12/#13 前端 → #14 灰度+T21。

## 移植参考（Python Agent 实测资产，代码现位于 `paimeng-ai-code-rag/`）

- 提示词 7 份：`paimeng-ai-code-rag/app/prompts/`（源 `src/main/resources/prompt/*.txt`）
- 解析正则：`paimeng-ai-code-rag/app/services/codegen/parsing.py`；guardrail：`paimeng-ai-code-rag/app/core/guardrails.py`
- 工具沙箱：`paimeng-ai-code-rag/app/workspace/manager.py`（`validate_workspace_path` + `atomic_write_files`）；图片四工具：`paimeng-ai-code-rag/app/services/images.py`
- 契约测试模式：`paimeng-ai-code-rag/tests/test_contract.py`（TS 侧按语义比对移植）

## 移植要点（Python 实测契约教训，TS 重写必须保持）

- vue 工具名/参数键必须驼峰（`writeFile/readFile/modifyFile/deleteFile/readDir/exit`、`relativeFilePath/oldContent/newContent`…），否则 Java `ToolManager` 与浏览器展示取 null。
- exit 工具的模型调用不确定：模型直接给最终答案时须补发 exit 事件（`exit-{uuid}`），保证事件序列与基线一致。
- 工作区原子写入：临时 stage 目录必须建在目标**父目录**（sibling），建在目标内部则 rename 时 stage 随之移动导致路径失效。
- Java `bodyToFlux(ServerSentEvent)` 解码 SSE 会产生 `data=null` 空事件：Java 客户端侧需 `filter(event -> event.data() != null)`（#6 泛化回调客户端时注意）。
- **Java 内部 API 的 Long 序列化为字符串**：`JsonConfig` 的 ToStringSerializer 会把 Long（appId/userId）序列化为字符串（防 JS 精度丢失，snowflake 18 位超安全整数）——TS run 客户端 `appId/userId` 类型必须兼容 `string | number`（#4 实测：响应 `"appId":"903"`）。

## 下一步 / 指针

- #5：`/agent/stream` 接假 LLM（Vercel AI SDK provider 抽象）+ XState 最小线性工作流 + 契约定稿 `docs/ts_agent/contract.md`（六类事件模型已在 `src/events.ts` 就位，可复用）；run 生命周期已就绪（#4），#5 生成流可在关键节点推进 phase/context/milestones。
- npm 坑：仓库根目录跑 npm 会读到 `/mnt/c/Users/LXH/.npmrc` 报 "config prefix cannot be changed"——命令必须在 `paimeng-ai-code-agent/` 目录内执行（有 package.json 后 project-config 解析止于该目录）。
- 进度日志：`docs/ts_agent/progress.md`（每完成一票追加一行，含命令证据）。
