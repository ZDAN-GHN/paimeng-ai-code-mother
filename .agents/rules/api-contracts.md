# API 契约

**前后端必须共享 API 契约。请求/响应类型来自共享层，前端不手写后端类型。**

## Java REST → 前端

后端 OpenAPI 文档是权威来源。

前端生成：

```bash
cd paimeng-ai-code-frontend && npm run openapi2ts
```

生成到 `src/api/`，修改后端字段后重新生成并检查调用方。

## TS Agent SSE 协议

权威文档：`docs/ts_agent/contract.md`

- Zod schema 校验
- 事件名、终态语义不可私自变更
- 浏览器 SSE 客户端：`paimeng-ai-code-frontend/src/utils/agentSse.ts`

浏览器到 Agent 的改动需前后端协同。

## Agent 内部调用

遵循架构约定：

- Bearer token 服务认证
- runId 幂等
- URL 约定

## 验收要求

新接口至少覆盖：

- 请求参数来源
- 成功响应
- 业务错误
- 鉴权失败
- 流式终态（如适用）

不凭后端实现或日志猜测字段。

## API 契约变更审查

**API 契约变更、跨服务调用设计变更前必须调用 `grilling` 技能**，检查设计风险、接口一致性、向后兼容性。
