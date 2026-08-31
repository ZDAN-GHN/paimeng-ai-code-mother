# 记忆：前端

> Vue3 前端工作记忆。主目录：`paimeng-ai-code-mother-frontend/`。

## 约定

- **代码风格**：Prettier 配置为无分号、单引号、100 字符宽度；Vue 3 Composition API；ESLint 检查。
- **命令**（在 `paimeng-ai-code-mother-frontend/` 内）：`npm run dev` / `npm run build` / `npm run type-check` / `npm run lint` / `npm run openapi2ts`（需先启动后端）。
- **环境配置**：已包含在 `.env.development`。

## SSE 消费基线

- `src/pages/app/AppChatPage.vue`（L478-582）用 EventSource 消费浏览器 wire：默认 message 事件 `data: {"d":"<文本>"}`、`event: done`、`event: business-error`。
- **本阶段不改** `AppChatPage.vue` 的事件消费逻辑（保持逐事件兼容，`task_plan.md` §2）。
- 浏览器侧 wire 由 Java 独占生成，前端不感知 Python 的存在。

## 与双后端的关系

- 前端只与 Java 后端通信（带 Cookie 的 EventSource）；Python Agent 对前端完全透明。
- 页面结构（Home/AppChat/AppEdit/AppManage/UserManage/ChatManage/登录注册）见 `CONTEXT.md`。
