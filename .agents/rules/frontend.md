# 前端规则

目录：`paimeng-ai-code-frontend/`

技术栈：Vue 3 + Vue Router + Pinia + Ant Design Vue + Axios + Vite

## 目录结构

```
src/
├── pages/        # 页面
├── components/   # 公共组件
├── stores/       # Pinia 状态
├── api/          # 生成的 API 类型和调用
├── utils/        # 工具函数
└── router/       # 路由配置
```

## API 调用

统一使用 `src/api/` 和 Axios 配置：

- 自动附加登录 cookie
- 统一错误处理
- 后端响应包装

不重新实现请求逻辑。

## 权限

路由权限 + 页面数据 + 后端鉴权三重检查。

管理员页面不能只靠隐藏菜单保护。

## SSE 生成流

使用 `fetch` + SSE，带 JWT header（不用 `EventSource`）。

处理状态：

- 连接中
- 数据接收
- 断开/错误
- done 终态
- 空数据

不只实现 happy path。

## UI 组件

使用 Ant Design Vue：

- Table、Pagination、Form、Modal、Button
- 完整状态：加载、空态、错误态、权限态

## 验证

```bash
npm run type-check  # 类型检查
npm run lint        # ESLint（会写入修复）
npm run build       # 构建检查
```
