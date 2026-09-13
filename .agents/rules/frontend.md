# 前端规则

前端目录为 `paimeng-ai-code-frontend/`，使用 Vue 3、Vue Router、Pinia、Ant Design Vue、Axios 和 Vite。页面放在 `src/pages/`，公共组件放在 `src/components/`，跨页面状态放在 `src/stores/`，格式化和校验放在 `src/utils/`。

请求统一沿用 `src/api/` 与现有 Axios 配置，保留登录 cookie、统一错误处理和后端响应包装。路由权限必须与页面入口和后端权限同时核对，管理员页面不能只靠隐藏菜单保护。

生成流按当前架构处理：P3 切换前不要擅自把浏览器改为直连 TS Agent；切换到直连协议时使用 fetch-SSE 和 JWT header，不用无法附加自定义 header 的 EventSource。处理断开、错误、done 和空数据状态，避免只实现 happy path。

UI 使用已有 Ant Design Vue 组件和项目视觉约定，表格、分页、表单、加载、空态、错误态和权限态应完整。改动后运行 `npm run type-check`、`npm run lint` 或 `npm run build` 中与风险匹配的检查。
