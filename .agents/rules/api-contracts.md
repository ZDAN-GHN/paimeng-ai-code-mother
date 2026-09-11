# API 契约

Frontend and backend must share API contracts. Request/response schemas and inferred types must live in a shared contract layer. Frontend code must not hand-write backend response types.

本仓库的具体落点：

- Java REST 接口和 OpenAPI 文档是业务 API 的服务端来源。
- 前端 `src/api/` 由 `npm run openapi2ts` 生成/维护调用类型；修改后端字段时同步重新生成并检查调用方。
- TS Agent 浏览器协议以 `docs/ts_agent/contract.md` 为权威，TS 侧使用 Zod schema 校验，事件名和终态语义不可私自变更。
- Agent 到 Java、Agent 到 RAG 的内部调用必须遵守架构文档中的 Bearer、runId 幂等和 URL 约定。

新增接口的验收至少包括：请求参数来源、成功响应、业务错误、鉴权失败和流式终态（如适用）。不要仅凭后端实现或网络日志猜测字段。
