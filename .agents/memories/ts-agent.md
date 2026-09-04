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
- 运行时环境布局（2026-09-04 起，**完全无软链**）：依赖与产物都在 `wsl-rt-env/ts-agent/`（`node_modules` + esbuild 产物 `dist/app.bundle.mjs`），服务目录内零 node_modules、零符号链接。WSL 通过 `bash scripts/run-wsl.sh <dev|start|build|test|type-check>` 进入 npm 调度器，脚本先校验 Linux/WSL；Windows/IDE 继续使用原有 npm 运行配置。构建模式 **esbuild 打包**（原 tsc 产物方案已废弃，`tsconfig.build.json` 已删）：ESM bundle + banner 注入 `createRequire`（fastify 内部有 CJS require），产物自包含、运行期不需要 node_modules；`src/config.ts` 以 `AGENT_ROOT` 环境变量定位服务目录（`.env`/`WORKSPACE_ROOT` 基准），由调度器注入。测试 `vitest.config.mjs` 用 `resolve.alias` 指向 wsl-rt-env 的包；类型检查 `tsconfig.json` 用 `paths` 映射各包 d.ts 文件（NodeNext 下 paths 目录映射无效，必须是文件；候选本地优先）。安装命令 `bash scripts/install-wsl-node-modules.sh`，运行入口 `bash scripts/run-wsl.sh`（默认 `dev`）。dev 重启链路由 esbuild watch `onEnd` 驱动（DrvFs 上 `node --watch` 收不到文件事件，实测确认）。
- **最小生成流已完成（Issue #5，2026-09-04 重做定稿）**：`POST /agent/stream` = **XState v5 线性工作流（`src/machine.ts`，interview→coding→review→done/failed）+ Vercel AI SDK provider 抽象假 LLM（`src/llm.ts`，`LanguageModelV2` + `customProvider` 注册 `scripted` 模型，零在线调用）+ `src/workflow.ts` 驱动**（`streamText` + `writeFile` 工具 + `stopWhen: isStepCount(2)` 工具循环，`fullStream` part → SSE 事件；AI SDK v7 已无 `maxSteps`）。成功路径推进 `interview → coding → review → done`，输出 milestone / ai_thinking / ai_response / tool_request → tool_executed / done；`script: error` 终止于 error（后无业务事件）且 run→failed。模型抛错被 AI SDK 吸收为流内 `error` part（循环正常结束），须在 switch 里显式抛出才能走 failed。工作区写入经沙箱校验，Java token 存在时经 #4 `RunClient` 更新 run；无 token 离线可跑。契约定稿 `docs/ts_agent/contract.md`，测试按语义断言；WSL `bash scripts/run-wsl.sh type-check` 通过、`bash scripts/run-wsl.sh test` **37/37**。运行时：`ai`/`xstate`/`@ai-sdk/provider` 落 wsl-rt-env（tsconfig paths + vitest alias 补映射）；**vitest 测试默认 `--configLoader runner`**（`$HOME/node_modules/.vite-temp` 被 Windows ACL 锁死 EACCES，runner 不打配置包绕开）。
- 实施票据链：~~#3 骨架~~ → ~~#4 run 生命周期~~ → ~~#5 最小生成流 + 契约定稿~~ → #6 回调打通 → #7-#9 核心能力 → #10 积分 → #11 对账 → #12/#13 前端 → #14 灰度+T21。

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

- #5：已完成 `POST /agent/stream` 假 LLM 最小生成流、线性 workflow、run phase 推进与 `docs/ts_agent/contract.md` 契约定稿；下一步 #6 Agent→Java 回调打通。
- npm 坑：仓库根目录跑 npm 会读到 `/mnt/c/Users/LXH/.npmrc` 报 "config prefix cannot be changed"——命令必须在 `paimeng-ai-code-agent/` 目录内执行（有 package.json 后 project-config 解析止于该目录）。
- 进度日志：`docs/ts_agent/progress.md`（每完成一票追加一行，含命令证据）。
