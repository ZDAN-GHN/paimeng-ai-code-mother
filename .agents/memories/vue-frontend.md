# 记忆：前端

> Vue3 前端工作记忆。主目录：`paimeng-ai-code-mother-frontend/`。

## 约定

- **代码风格**：Prettier 配置为无分号、单引号、100 字符宽度；Vue 3 Composition API；ESLint 检查。
- **命令**（在 `paimeng-ai-code-mother-frontend/` 内）：WSL 使用 `bash scripts/run-wsl.sh <dev|build|type-check|lint|openapi2ts>`；Windows/IDE 仍使用原有 `npm run <script>` 配置。
- **WSL 运行时布局（2026-09-04 已实施）**：实体依赖位于 `wsl-rt-env/frontend/node_modules`，Vite 缓存和构建产物分别位于 `wsl-rt-env/frontend/vite-cache`、`wsl-rt-env/frontend/dist`，无软链。WSL 安装固定执行 `bash scripts/install-wsl-node-modules.sh`，启动/构建固定执行 `bash scripts/run-wsl.sh <command>`；两个脚本均校验 Linux/WSL。Windows/IDE 只使用服务目录本地 `node_modules`，原有 npm 运行配置不变。
- **环境配置**：已包含在 `.env.development`。

## SSE 消费基线

- `src/pages/app/AppChatPage.vue`（L478-582）用 EventSource 消费浏览器 wire：默认 message 事件 `data: {"d":"<文本>"}`、`event: done`、`event: business-error`。
- **过渡期不改** `AppChatPage.vue` 的事件消费逻辑（P3 前保持与旧 Java AI 链路兼容）。
- 浏览器侧 wire 由 Java 独占生成，前端不感知 Python 的存在。

## P3 计划改造（2026-09-03 定稿，见 `docs/ts_agent/architecture.md` §2）

- SSE 消费从 EventSource（cookie）改为 **fetch 流式 + JWT Authorization header**（EventSource 不支持自定义 header）；服务端从 Java 中转改为直连 TS Agent。
- 事件协议换新：四类事件（`ai_response`/`ai_thinking`/`tool_request`/`tool_executed`）语义保留、扔掉 `data:{"d":...}` 包装、新增 `milestone` 一等事件与 `done`/`error` 终态（契约落 `docs/ts_agent/contract.md`，P1 产出）。
- 新增 UI：线框确认界面（iframe 预览 + 确认/反馈）、推理强度三档选择器（输入框旁，默认标准）、中止按钮、积分/余额显示。

## 与三服务架构的关系

- 前端同时与 Java（cookie session：业务/登录/积分/历史）和 TS Agent（JWT：生成流）通信；Python RAG 对前端透明。
- 页面结构（Home/AppChat/AppEdit/AppManage/UserManage/ChatManage/登录注册）见 `CONTEXT.md`。
