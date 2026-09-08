# 记忆：TS Agent（Node，`paimeng-ai-code-agent/`）

> 目标架构权威：`docs/ts_agent/architecture.md`；wire 契约（#5 定稿）：`docs/ts_agent/contract.md`；对等报告：`docs/ts_agent/contract-parity.md`。本文件只记实施结论、有效约定与移植指针，逐票细节与命令证据见 `docs/ts_agent/progress.md`。

## 当前状态（**P3 收官：#3-#14 全部完成**，2026-09-08；TS Agent 直连链路为唯一生成实现）

- **#3 骨架**：Fastify 5 + TS 5.9 + jose 6 + vitest 3，端口 8092；`GET /healthz` 无鉴权，其余路由 JWT 保护；沙箱校验含 realpath 符号链接消解。
- **#4 run 客户端**：`src/internal/runClient.ts` 对接 Java 内部 API（createRun/updateRun/getRun/getLatestNonTerminalRun/completeRun/freezeCredit，Bearer）；409→`RunConflictError`「当前有进行中的任务」，401/网络失败→`RunApiError`；配置 `JAVA_INTERNAL_BASE_URL`（默认 `http://localhost:8123/api`）/`JAVA_INTERNAL_TOKEN`。
- **#5 最小生成流 + 契约定稿**：XState v5 状态机（`src/workflow/machine.ts`，interview→coding→review→done/failed）+ Vercel AI SDK v7 `streamText` 工具循环（`src/workflow/index.ts`；v7 无 `maxSteps`，用 `stopWhen`）+ 脚本化假 LLM（`src/llm/index.ts`，`LanguageModelV2` + `customProvider`，零在线调用）；模型抛错被 AI SDK 吸收为流内 `error` part，须在 switch 里显式抛出才走 failed。
- **#6 完成回调**：workflow 终态 `notifyComplete()` 写对话历史 + Java 触发构建；appId/userId 字符串传输防精度丢失；回调失败不阻断主流程。**踩坑：回调必须在 `yield {type:'done'|'error'}` 之前**——路由收到终态即 break，async generator 不再 resume。
- **#7 需求工程**：五维访谈（每维 2-4 选项、`MAX_INTERVIEW_ROUNDS=2`、状态持久化 `run.context.interview` 跨请求存活；重新访谈会失效旧线框）+ 免费线框（单文件 HTML、`PAGE_LIMIT=5`、落 `{workspace}/wireframe/`）+ **codegen 闸门**（非 `wireframe_confirmed` 拒绝且不再 createRun；未配置内部 API 同样拒绝放行）+ 线框每日配额（Java Redisson，超限 429）。
- **#8 生成核心移植**：Guardrail（`src/interview/guardrails.ts`）+ 代码块解析（`src/codegen/parsing.ts`，正则对齐 Python）+ 文件六工具（`src/tools/fileTools.ts`，IMPORTANT_FILES 保护 + FilePathError 越界）+ 图片四工具（配额 4 张/run，用尽返回 `IMAGE_QUOTA_EXCEEDED_MESSAGE`）+ 提示词 7 份（`src/prompts/`）+ 10 工具注册（`src/tools/index.ts`）。
- **#9 质检门禁 + 护栏 + 三档**：三工位循环（coding↔review 有界重试 `MAX_QUALITY_RETRIES=2`）+ 三重门禁（`src/review/`：质检分/build/**视觉 diff 基准 = 已确认线框**）+ 护栏（`src/intensity.ts` 三档 fast/standard/deep，超限**优雅收尾绝不硬杀**：finishReason 判定截断 → generateText 注入收尾指令 → 状态机照常推进）+ 输入滑窗（`src/workflow/history.ts`）+ token 计量按 run 落库。
- **#10 积分 + 对话中断**：冻结时点 = 闸门后进 codegen 前（余额不足 402 唯一 error 事件拒绝）；abortSignal 贯穿 streamText/generateText/质检工位，`throwIfAborted` 覆盖工具执行间隙（仅靠流内感知会漏到 done）；aborted 保留已写文件 + 按里程碑退款（首文件前全额退）；`FileTools.filesWritten` = 已落盘**不同文件数**（modifyFile 计数、同文件去重、deleteFile 移除）。
- **#11 契约对账**：84 例逐文件对账（72 覆盖 / 3 语义差异 / 9 有意演进），T21「契约对等」判据**通过**；补齐缺口 5 项（golden e2e×2、工具名契约、质检拼接、护轨拒绝回调、回调失败容错），`npm test` **144/144**。教训：2026-09-07 曾基于未 fetch 的本地 clone 误判 #7-#10/#12「幻影关闭」——**核对远程仓库而非本地 clone 再下结论**。
- **#12 前端通道切换**：Agent 侧零代码改动（JWT 验签 #3 已就位）；`JWT_SECRET` 与 Java `ts-agent.jwt.secret` 同值（均不提交；#14 起配置段更名 ts-agent.*，开关 `ts-agent.enabled` 门禁 Java 签发端点，关闭→40410）。

## 通用有效约定

- JWT：HS256 共享密钥离线验签（`algorithms` 白名单防混淆、requiredClaims `exp`/`sub`）；`WORKSPACE_ROOT` 默认按服务目录解析 `../tmp/code_output`（对齐 Java `user.dir/tmp/code_output`）。
- 测试基建：真实服务实例 `buildApp(overrides)` + `fastify.inject()` + 自签 JWT（`test/helpers.ts`；frames/fakeRunClient/RunCall 已统一提取，golden 与 stream 共用）。
- 配置键：`PEXELS_API_KEY`/`DASHSCOPE_API_KEY`/`IMAGE_MODEL`/`MODEL_FAST|STANDARD|DEEP`（.env.example 已加）。

## 测试基建坑（跨票复用）

- **vitest 必须 `--configLoader runner`**：`$HOME/node_modules/.vite-temp` 被 Windows ACL 锁死 EACCES，runner 不打配置包绕开；vitest 超时提到 20s（真死循环仍暴露）。
- `.env` 的 `JAVA_INTERNAL_TOKEN` 会被 `loadDotEnv` 读进 config，`buildTestApp` 默认离线必须显式 `javaInternalToken: ''`，否则测试误连真实 Java。
- e2e 假 LLM 产物仅单页区段，多页线框必触发视觉 diff 失败、重试耗尽——**e2e 成功剧本须选单页线框（pageCount=1）**。
- 被闸门拒绝的 run 停在非终态，会挡同 app 后续 createRun（409）——测试残留须经内部 API `PATCH /internal/runs/{runId}` phase=failed 清理。
- AI SDK 并行执行工具时 tool-result 顺序与 tool-call 可不同（断言须按 id 配对）；JS 正则用 `exec`（非 Python `search`）。

## 移植参考（Python Agent 实测资产，代码现位于 `paimeng-ai-code-rag/`）

- 提示词 7 份：`paimeng-ai-code-rag/app/prompts/`（源 `src/main/resources/prompt/*.txt`）
- 解析正则：`paimeng-ai-code-rag/app/services/codegen/parsing.py`；guardrail：`paimeng-ai-code-rag/app/core/guardrails.py`
- 工具沙箱：`paimeng-ai-code-rag/app/workspace/manager.py`（`validate_workspace_path` + `atomic_write_files`）；图片四工具：`paimeng-ai-code-rag/app/services/images.py`
- 契约测试模式：`paimeng-ai-code-rag/tests/test_contract.py`（TS 侧按语义比对移植）

## 移植要点（Python 实测契约教训，TS 重写必须保持）

- vue 工具名/参数键必须驼峰（`writeFile/readFile/modifyFile/deleteFile/readDir/exit`、`relativeFilePath/oldContent/newContent`…），否则 Java `ToolManager` 与浏览器展示取 null。
- exit 工具的模型调用不确定：模型直接给最终答案时须补发 exit 事件（`exit-{uuid}`），保证事件序列与基线一致。
- 工作区原子写入：临时 stage 目录必须建在目标**父目录**（sibling），建在内部则 rename 时 stage 随之移动导致路径失效。
- Java `bodyToFlux(ServerSentEvent)` 解码 SSE 会产生 `data=null` 空事件：Java 客户端侧需 `filter(event -> event.data() != null)`。
- Java 内部 API 的 Long 一律字符串序列化（`JsonConfig` ToStringSerializer，snowflake 18 位超安全整数）——TS 类型须兼容 `string | number`。

## 下一步 / 指针

- #14 灰度 + T21 删除旧链路；进度日志 `docs/ts_agent/progress.md`（每完成一票追加一行，含命令证据）。
- npm 坑：命令必须在 `paimeng-ai-code-agent/` 目录内执行（仓库根目录会读到 `/mnt/c/Users/LXH/.npmrc` 报 "config prefix cannot be changed"）。
- 运行时目录按宿主分流（原生 Linux 默认 / WSL 用 `wsl-rt-env/`）见 `deployment.md`。
