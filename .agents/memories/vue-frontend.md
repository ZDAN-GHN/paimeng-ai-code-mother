# 记忆：前端

> Vue3 前端工作记忆。主目录：`paimeng-ai-code-mother-frontend/`；运行时目录分宿主约定与安装/启动命令见 `deployment.md`。

## 约定

- **代码风格**：Prettier 无分号、单引号、100 字符宽；Vue 3 Composition API；ESLint 检查；环境配置在 `.env.development`。
- **命令**：原生 Linux/Windows 标准 `npm run <dev|build|type-check|lint|openapi2ts>`；WSL 宿主 `bash scripts/run-wsl.sh <...>`（依赖/Vite 缓存/产物在 `wsl-rt-env/frontend/`，无软链，详见 `deployment.md`）。

## SSE 消费基线（#12 通道切换，2026-09-04）

- `AppChatPage.vue` 的 `generateCode`：先 `GET /app/agent/token`（登录态换短时 JWT + workspacePath，Java 计算）→ POST `/agent/stream`（`Authorization: Bearer`；EventSource 不支持自定义 header 故用 fetch）。
- 解析器 `src/utils/agentSse.ts`：空行分帧、多行 data 重组、type 与 event 一致性校验、AbortSignal（onUnmounted 中止）、终态事件返回 done/error；`AgentStreamHttpError.status` 区分 401（明确提示重新登录 + 跳登录页，非挂起）与其他失败。
- 七类事件渲染：ai_response→Markdown、ai_thinking→折叠面板、milestone→进度条、tool_request/tool_executed→按 id 配对步骤、done→刷新预览（完成回调先于 done，构建已完成）、error→明确报错。
- 路由：vite 代理 `/api→8123`、`/agent→8092`（vite.config.ts）；生产 nginx 同路径（`deploy/nginx.conf.example`）。浏览器↔Java 走 cookie session（`/api/*`），浏览器↔Agent 走 JWT（`/agent/*`），wire 契约 `docs/ts_agent/contract.md`。
- codegen 受线框闸门约束：`/agent/stream` 仅在 run 处于 `wireframe_confirmed` 时放行。

## lint 环境要点（2026-09-04/05 定稿）

- WSL `lint` 需 `NODE_PATH` 指向 wsl-rt-env 实体依赖（eslint.config.ts 顶层裸导入 `eslint/config` 无法解析，已在 run.mjs 注入）。
- **dev/preview/build-only 禁用 `--configLoader runner`**（2026-09-05 修正，提交 318f099）：runner 模式下 config 加载完临时 runner 即关闭，vue/vue-devtools 插件运行期懒加载报 `Vite module runner has been closed`（Windows/WSL 均复现）；#12 引入 runner 规避的 EROFS 前提经实测不成立。**边界**：ts-agent 侧 vitest 的 runner 仍健康——崩溃仅限 dev server 场景，勿顺手改动。
- **裸导入解析禁止 `enforce: 'pre'` 直返文件路径**（提交 9fd75f1/1672bf0）：绕过依赖预构建后浏览器原生加载 CJS 产物（vue/ant-design-vue 的 lib/index.js）报 `does not provide an export named 'xxx'` 整页白屏；`runtimeDependencyResolver` 退居普通顺序兜底，仅对裸包名导入返回 ESM 入口，CJS-only 包与 deep import 返回 null 由 Vite 显式报错。
- `src/api/**` 为 openapi2ts 生成文件，已在 eslint.config.ts globalIgnores 豁免（生成模板 `@ts-ignore` 头过不了 ban-ts-comment）；手写接口封装（如 `src/api/agentToken.ts`）单独放行。

## #13 前端功能补齐（2026-09-08 完成，commit 2ebacd6 + 双轴审查整改）

- **旅程状态机**（`AppChatPage.vue` `journeyPhase`：idle→interviewing→wireframe_pending→wireframe_confirmed→生成→idle）：首次发送=开始旅程（创建 runId 调 `/agent/interview`），五维选择题 `InterviewQuestionsCard` 进对话流；收束自动 `requestWireframe`；`WireframeReviewCard` 提供「确认/重新生成线框/重新访谈」。**生成必须复用旅程 runId**（闸门与积分冻结校验该 run 的 phase，`createRunId()` 直连必被拒）。
- **新组件**：`InterviewQuestionsCard`、`WireframeReviewCard`、`IntensitySelector`（三档**下拉列表**，每选项说明该档预估积分；定价 fast=0.5/standard=1/deep=2，四舍五入对齐 Java `calcFrozenAmount`）；手写 `api/creditController.ts`（`GET /credit/balance`，未纳入 openapi2ts）。
- **agentSse.ts 扩展**：`requestInterview`/`requestWireframe`/`confirmWireframe`（统一 JWT + 状态码透传）+ stream 参数 `intensity`/`history`；共享 `Intensity` 类型。
- **中止按钮**：生成中发送键切「停止」→ abort 断连 → Agent aborted → 退款；catch 区分 `AbortError`；余额刷新有 2s 延迟补刷（等退款落账竞态）。
- **契约要点**：线框预览 URL 以接口返回 `relativeUrl` 拼 `${STATIC_BASE_URL}/{codeGenType}_{appId}/`（时间戳破缓存）；401/429/409 走 `AgentStreamHttpError.status` 分派提示；需求工程失败旅程回 idle（用户重发消息重启，避免禁用卡死锁）。
- **教训**：假 LLM 毫秒级产出使 HTTP 层中止窗口极窄（0.4s 断开已是 done+SETTLED，30ms 才稳定 aborted）；`defineProps` 不写字段注释（project-comment-style）；Message 用判别联合（type 区分形态）避免可选字段堆叠。
- 仅剩浏览器 UI 人工走查（AC1 勾选留用户）。

## 与三服务架构的关系

- 前端同时与 Java（cookie session：业务/登录/积分/历史）和 TS Agent（JWT：生成流）通信；Python RAG 对前端透明。
- 页面结构（Home/AppChat/AppEdit/AppManage/UserManage/ChatManage/登录注册）见 `CONTEXT.md`。
