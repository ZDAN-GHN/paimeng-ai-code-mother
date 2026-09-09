# 记忆：TS Agent（Node，`paimeng-ai-code-agent/`）

> 目标架构权威：`docs/ts_agent/architecture.md`；wire 契约（#5 定稿）：`docs/ts_agent/contract.md`；对等报告：`docs/ts_agent/contract-parity.md`。本文件只记实施结论、有效约定与移植指针，逐票细节与命令证据见 `docs/ts_agent/progress.md`。

## 当前状态（**P3 收官 + 架构优雅化第一批 4/6（#16 目录收敛、#17 真流式、#18 zod 单源、#20 重试策略完成）**，2026-09-08；TS Agent 直连链路为唯一生成实现）

- **#3 骨架**：Fastify 5 + TS 5.9 + jose 6 + vitest 3，端口 8092；`GET /healthz` 无鉴权，其余路由 JWT 保护；沙箱校验含 realpath 符号链接消解。
- **#4 run 客户端**：`src/runs/runClient.ts` 对接 Java 内部 API（createRun/updateRun/getRun/getLatestNonTerminalRun/completeRun/freezeCredit，Bearer）；409→`RunConflictError`「当前有进行中的任务」，401/网络失败→`RunApiError`；配置 `JAVA_INTERNAL_BASE_URL`（默认 `http://localhost:8123/api`）/`JAVA_INTERNAL_TOKEN`。
- **#5 最小生成流 + 契约定稿**：XState v5 状态机（`src/generation/workflow/machine.ts`，interview→coding→review→done/failed）+ Vercel AI SDK v7 `streamText` 工具循环（`src/generation/workflow/index.ts`；v7 无 `maxSteps`，用 `stopWhen`）+ 脚本化假 LLM（`src/llm/index.ts`，`LanguageModelV2` + `customProvider`，零在线调用）；模型抛错被 AI SDK 吸收为流内 `error` part，须在 switch 里显式抛出才走 failed。
- **#6 完成回调**：workflow 终态 `notifyComplete()` 写对话历史 + Java 触发构建；appId/userId 字符串传输防精度丢失；回调失败不阻断主流程。**踩坑：回调必须在 `yield {type:'done'|'error'}` 之前**——路由收到终态即 break，async generator 不再 resume。
- **#7 需求工程**：五维访谈（每维 2-4 选项、`MAX_INTERVIEW_ROUNDS=2`、状态持久化 `run.context.interview` 跨请求存活；重新访谈会失效旧线框）+ 免费线框（单文件 HTML、`PAGE_LIMIT=5`、落 `{workspace}/wireframe/`）+ **codegen 闸门**（非 `wireframe_confirmed` 拒绝且不再 createRun；未配置内部 API 同样拒绝放行）+ 线框每日配额（Java Redisson，超限 429）。
- **#8 生成核心移植**：Guardrail（`src/interview/guardrails.ts`）+ 代码块解析（`src/codegen/parsing.ts`，正则对齐 Python；#16 判定零生产调用已删）+ 文件六工具（`src/generation/tools/fileTools.ts`，IMPORTANT_FILES 保护 + FilePathError 越界）+ 图片四工具（配额 4 张/run，用尽返回 `IMAGE_QUOTA_EXCEEDED_MESSAGE`）+ 提示词 7 份（`src/generation/prompts/`，#16 清至生产在用 2 份）+ 10 工具注册（`src/generation/tools/index.ts`）。
- **#9 质检门禁 + 护栏 + 三档**：三工位循环（coding↔review 有界重试 `MAX_QUALITY_RETRIES=2`）+ 三重门禁（`src/generation/review/`：质检分/build/**视觉 diff 基准 = 已确认线框**）+ 护栏（`src/generation/intensity.ts` 三档 fast/standard/deep，超限**优雅收尾绝不硬杀**：finishReason 判定截断 → generateText 注入收尾指令 → 状态机照常推进）+ 输入滑窗（`src/generation/workflow/history.ts`）+ token 计量按 run 落库。
- **#10 积分 + 对话中断**：冻结时点 = 闸门后进 codegen 前（余额不足 402 唯一 error 事件拒绝）；abortSignal 贯穿 streamText/generateText/质检工位，`throwIfAborted` 覆盖工具执行间隙（仅靠流内感知会漏到 done）；aborted 保留已写文件 + 按里程碑退款（首文件前全额退）；`FileTools.filesWritten` = 已落盘**不同文件数**（modifyFile 计数、同文件去重、deleteFile 移除）。
- **#11 契约对账**：84 例逐文件对账（72 覆盖 / 3 语义差异 / 9 有意演进），T21「契约对等」判据**通过**；补齐缺口 5 项（golden e2e×2、工具名契约、质检拼接、护轨拒绝回调、回调失败容错），`npm test` **144/144**。教训：2026-09-07 曾基于未 fetch 的本地 clone 误判 #7-#10/#12「幻影关闭」——**核对远程仓库而非本地 clone 再下结论**。
- **#12 前端通道切换**：Agent 侧零代码改动（JWT 验签 #3 已就位）；`JWT_SECRET` 与 Java `ts-agent.jwt.secret` 同值（均不提交；#14 起配置段更名 ts-agent.*，开关 `ts-agent.enabled` 门禁 Java 签发端点，关闭→40410）。
- **#16 目录收敛 + 死代码清场（2026-09-08，零行为变更 156→148/148）**：src/ 收敛为 6 领域目录——server/（装配/路由/鉴权/配置+agentRoot）、protocol/（events+sse 编码）、runs/（原 internal/，名不副实故改）、interview/、generation/（workflow+review+tools+prompts+intensity+workspace）、llm/；**旧路径换算：workflow/review/tools/prompts/intensity/workspace → generation/ 下，internal → runs，routes/auth/app/config → server，sse/ 与 workflow/events → protocol**。死代码清场：parsing.ts（连同 6 例测试）、提示词 7→2 份（原件 rag 仓库留档）、SSE formatEvent/encodeEvent 去 export、runImageTool 透传包装、ScriptedLlmProvider 空别名；config 反向依赖修正（DEFAULT_IMAGE_MODEL + 三图片源常量归 server/config.ts）。commit：8dae1e1/a90c9ab/eee514b/83bf9f2 + 审查整改 2dfaa4e（README 结构节对齐）。
- **test/ 与 src/ 路径对称分包（2026-09-08，b6751ed）**：test/{server,protocol,runs,interview,generation,llm}/ 镜像 src（generation 内 workflow/tools/review 子目录同构，跨子域的 quality-gate 集成落域根）；helpers.ts、fixtures/ 与跨域 golden-e2e 留顶层；纯移动零断言变更 148/148。
- **#17 真流式 + #18 zod 单源 + #20 重试参数化（2026-09-08，三票 worktree 并行 + 主会话整合）**：`/agent/stream` hijack 后 reply.raw 逐帧直写（SSE_HEADERS 单点、断连走既有 abort 通路、日志 logger 化；**「Java 转发链路」已随 T21 消失**，实际浏览器路径 = Vite 代理/nginx 直连 8092，nginx example 已配 proxy_buffering off）；zod 成为工具入参与路由 body 单源（`input as` 清零、FileToolResult 判别联合、宽容回退语义等价 4xx 路径不变）；重试按类别参数化（短调用 `SHORT_CALL_MAX_RETRIES` 单源、长生成 0）。测试 148→**160/160**。执行教训：三票并行用 git worktree 隔离可行（rename 检测化解测试树移动冲突）；#18 实施中断于收尾阶段，核验现场后恢复原 agent 续跑即可。留档给 #21：三个 body schema 的 runId/appId/userId 字段形状重复 ×3、stream handler 4 处 error 帧同形；已知微隙：hijack/close 微秒级间隙（帧被守卫丢弃不挂死）。

## 通用有效约定

- JWT：HS256 共享密钥离线验签（`algorithms` 白名单防混淆、requiredClaims `exp`/`sub`）；`WORKSPACE_ROOT` 默认按服务目录解析 `../tmp/code_output`（对齐 Java `user.dir/tmp/code_output`）。
- 测试基建：真实服务实例 `buildApp(overrides)` + `fastify.inject()` + 自签 JWT（`test/helpers.ts`；frames/fakeRunClient/RunCall 已统一提取，golden 与 stream 共用）。
- 配置键：`PEXELS_API_KEY`/`DASHSCOPE_API_KEY`/`IMAGE_MODEL`/`MODEL_FAST|STANDARD|DEEP`（.env.example 已加）。
- **模型选型与真实 provider 接入（2026-09-08 用户拍板并落地）**：路由档（`MODEL_ROUTER`，调用点为后续特性）= 智谱 `glm-4-flash-250414`；快速档（`MODEL_FAST`）= 智谱 `glm-4.7-flash`（质检档 scripted-quality 复用快速模型）；标准档（`MODEL_STANDARD`）= OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`（免费 50 请求/天、充 $10 升 1000，国内需代理）；深度档（`MODEL_DEEP`）= **qwen3.7-plus @ DashScope Coding**（`coding.dashscope.aliyuncs.com/v1`，用户变更：弃 glm-5.3-flash 自备 baseUrl 方案）。接入实现 `src/llm/real.ts`（渠道表驱动）：三渠道 OpenAI 兼容（`@ai-sdk/openai-compatible@3.0.44`，产出 v4 spec 经 `ai@7.0.92` customProvider 包装兼容）→ customProvider 同形输出；路由层按配置装配——**三渠道密钥须齐全（缺一 fail-fast 拒启，部分配置=启动失败而非渠道级降级）**，全空回退假 LLM；provider 注入类型 `LlmProvider = Pick<ReturnType<typeof customProvider>,'languageModel'>`（以 SDK 工厂形态为准，不寄生替身类型）。离线单测 `test/llm/llm-real.test.ts` 覆盖 fail-fast/别名双注册/thinking 补丁/归一化转码（stub 全局 fetch 零外呼）。真 key 只进 .env（不提交）。
- **真实 LLM 渠道坑（跨票复用）**：① 智谱 glm-4.7-flash 默认输出思考且 reasoning 计入 max_tokens——快速/路由/质检请求在渠道层注入 `thinking:{type:'disabled'}`（src/llm/real.ts createChannelFetch），否则快速档 3000 上限被思考吃光；② 智谱 1305 挤爆与 OpenRouter 上游 502 均以 **HTTP 200 包 `{"error":...}`** 返回，AI SDK 对 200 不重试且报「Invalid JSON response」——渠道 fetch 层归一化：上游 4xx/5xx 原样、1305→429、其余业务码→400 快速失败（鉴权类不空转重试）、非 JSON→502，触发 SDK 内建重试；③ 智谱免费池时延方差大（同冒烟 prompt 6.7s ↔ 57.8s，过载时段成片 1305），生产接付费或降级预案待定；④ 新增渠道需同步四处：config.ts 键定义 / test/helpers.ts 清空清单 / real.ts 渠道表 / .env.example 模板（real.ts 文件头有注记）。

## 测试基建坑（跨票复用）

- **vitest 必须 `--configLoader runner`**：`$HOME/node_modules/.vite-temp` 被 Windows ACL 锁死 EACCES，runner 不打配置包绕开；vitest 超时提到 20s（真死循环仍暴露）。
- `.env` 的 `JAVA_INTERNAL_TOKEN` 会被 `loadDotEnv` 读进 config，`buildTestApp` 默认离线必须显式 `javaInternalToken: ''`，否则测试误连真实 Java。
- e2e 假 LLM 产物仅单页区段，多页线框必触发视觉 diff 失败、重试耗尽——**e2e 成功剧本须选单页线框（pageCount=1）**。
- 被闸门拒绝的 run 停在非终态，会挡同 app 后续 createRun（409）——测试残留须经内部 API `PATCH /internal/runs/{runId}` phase=failed 清理。
- AI SDK 并行执行工具时 tool-result 顺序与 tool-call 可不同（断言须按 id 配对）；JS 正则用 `exec`（非 Python `search`）。
- **离线/假 LLM 验证环境须同时清空渠道 key 与 MODEL_***：.env 的 MODEL_* 会覆盖假 LLM 的 scripted 模型路由（customProvider 抛 No such languageModel，SSE 立即 error 终态）——真服务冒烟已两次踩中。

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

- **架构优雅化第一批（父 issue #15）**：#16/#17/#18/#20 ✅ 完成（2026-09-08，见当前状态）→ **frontier：#19 质检 generateObject、#21 路由收敛（均已解锁）**。#21 弹药（双轴审查留档）：三个 body schema 的 runId/appId/userId 字段形状重复 ×3 可提取共享 shape、stream handler 4 处 error 帧同形可折局部 fail()；#21 落地后 #15 收口。审查根因结论在 #15 正文；**XState「图只簿记不驱动控制流」双轨决策待用户拍板（#22，关键变量 = P2 断点续传的快照序列化预期）**，不进第一批链。
- 路由模型调用点（自动选档/工位识别）尚未实现——`MODEL_ROUTER` 与 provider 映射已打通，行为设计（规则前置 or LLM 判档、超时回退默认档）需先出设计再动工。
- 进度日志 `docs/ts_agent/progress.md`（每完成一票追加一行，含命令证据）。
- npm 坑：命令必须在 `paimeng-ai-code-agent/` 目录内执行（仓库根目录会读到 `/mnt/c/Users/LXH/.npmrc` 报 "config prefix cannot be changed"）。
- 运行时目录按宿主分流（原生 Linux 默认 / WSL 用 `wsl-rt-env/`）见 `deployment.md`。
