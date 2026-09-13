# 测试与验收

按被测代码路径镜像测试目录；跨域集成测试和 helpers/fixtures 放测试树顶层。新增行为至少覆盖成功路径、主要失败路径和权限/边界条件。

可用命令：

- TS Agent：在 `paimeng-ai-code-agent/` 执行 `npm run type-check`、`npm run test`、`npm run build`。
- Vue 前端：在 `paimeng-ai-code-frontend/` 执行 `npm run type-check`、`npm run lint`、`npm run build`；类型生成使用 `npm run openapi2ts`。
- Java：在 `paimeng-ai-code-backend/` 使用 `./mvnw`，JDK 21；按改动范围执行 compile/test。
- Python RAG：当前为 P4 范围，未授权前不要安装、启动或把旧 Agent 测试当作当前主链路验收。

联调验收按层次进行：服务健康、鉴权、接口契约、SSE 事件和终态、工作区/构建结果。不要因单个 `/healthz` 成功就断言全链路可用。Issue 有 Acceptance criteria 时，交付前逐条勾选。
