# 记忆：前端

> Vue3 前端工作记忆。主目录：`paimeng-ai-code-mother-frontend/`。

## 约定

- **代码风格**：Prettier 配置为无分号、单引号、100 字符宽度；Vue 3 Composition API；ESLint 检查。
- **命令**（在 `paimeng-ai-code-mother-frontend/` 内）：WSL 使用 `bash scripts/run-wsl.sh <dev|build|type-check|lint|openapi2ts>`；Windows/IDE 仍使用原有 `npm run <script>` 配置。
- **WSL 运行时布局（2026-09-04 已实施）**：实体依赖位于 `wsl-rt-env/frontend/node_modules`，Vite 缓存和构建产物分别位于 `wsl-rt-env/frontend/vite-cache`、`wsl-rt-env/frontend/dist`，无软链。WSL 安装固定执行 `bash scripts/install-wsl-node-modules.sh`，启动/构建固定执行 `bash scripts/run-wsl.sh <command>`；两个脚本均校验 Linux/WSL。Windows/IDE 只使用服务目录本地 `node_modules`，原有 npm 运行配置不变。
- **环境配置**：已包含在 `.env.development`。

## SSE 消费基线（#12 已切换新通道，2026-09-04）

- `src/pages/app/AppChatPage.vue` 的 `generateCode` 已改为 **fetch-SSE 直连 TS Agent**：先 `GET /app/agent/token`（登录态换短时 JWT + workspacePath，Java 计算），再 POST `/agent/stream`（`Authorization: Bearer`；EventSource 不支持自定义 header）。
- 解析器 `src/utils/agentSse.ts`：空行分帧、多行 data 重组、type 与 event 一致性校验、AbortSignal（onUnmounted 中止）、返回终态事件（done/error）；`AgentStreamHttpError.status` 区分 401（明确提示重新登录 + 跳登录页，非挂起）与其他失败。
- 七类事件渲染在 `AppChatPage.vue`：ai_response→Markdown、ai_thinking→折叠面板、milestone→tag 进度条、tool_request/tool_executed→按 id 配对步骤、done→刷新预览（完成回调先于 done，构建已完成）、error→明确报错。
- 浏览器与 Java 仍走 cookie session（`/api/*`）；Agent 请求全部带 JWT（`/agent/*`）。浏览器侧 wire 由 TS Agent 生成（契约 `docs/ts_agent/contract.md`）。
- vite 代理：`/api→8123`、`/agent→8092`（vite.config.ts）；生产 nginx 同路径（`deploy/nginx.conf.example`）。
- **注意**：codegen 受 #7 线框闸门约束——`/agent/stream` 仅在 run 处于 `wireframe_confirmed` 时放行，未确认时返回唯一 error 事件；访谈/线框/确认 UI 属 #13。

## 前端 lint 环境与命令（2026-09-04 #12 修复；2026-09-05 dev 环境修正）

- WSL 下 `bash scripts/run-wsl.sh lint` 需要 `NODE_PATH` 指向 wsl-rt-env 实体依赖（eslint.config.ts 顶层裸导入 `eslint/config` 无法解析；已在 run.mjs 注入）。
- **dev/preview/build-only 禁用 `--configLoader runner`**（2026-09-05 修正，提交 318f099）：config 在临时 runner 中加载完 runner 即关闭，vue/vue-devtools 插件运行期再经 runner 懒加载模块报 `Vite module runner has been closed`，Windows 与 WSL 均复现；#12 时引入 runner 所规避的 EROFS 前提经实测不成立（bundle 模式启动零警告，项目内 node_modules 可写）。**边界**：ts-agent 侧 vitest 仍用 runner 且健康（85/85）——崩溃仅发生在 dev server 场景（插件运行期懒加载路径），勿顺手改动 vitest 的 runner。
- **裸导入解析禁止 `enforce: 'pre'` 直返文件路径**（2026-09-05 修正，提交 9fd75f1/1672bf0）：绕过依赖预构建后浏览器原生加载 CJS 产物（vue/index.js、ant-design-vue/lib/index.js 等）报 `does not provide an export named 'xxx'`，整页白屏；`runtimeDependencyResolver` 已退居普通顺序兜底位，且仅对裸包名导入返回 ESM 入口（嵌套 import conditions 取 default），CJS-only 包与 deep import 返回 null 由 Vite 显式报错。
- `src/api/**` 为 openapi2ts 生成文件，已在 eslint.config.ts globalIgnores 豁免（生成模板 `@ts-ignore` 头过不了 ban-ts-comment）；手写接口封装（如 `src/api/agentToken.ts`）单独放行。

## #13 待办（P3 前端功能补齐）

- 新增 UI：线框确认界面（iframe 预览 + 确认/反馈）、推理强度三档选择器（输入框旁，默认标准）、中止按钮、积分/余额显示（中止的 AbortController 基础已在 `streamAbortController` 就位）。

## 与三服务架构的关系

- 前端同时与 Java（cookie session：业务/登录/积分/历史）和 TS Agent（JWT：生成流）通信；Python RAG 对前端透明。
- 页面结构（Home/AppChat/AppEdit/AppManage/UserManage/ChatManage/登录注册）见 `CONTEXT.md`。
