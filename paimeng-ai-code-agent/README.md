# paimeng-ai-code-agent（TS Agent）

三服务架构（Java 8123 / **TS Agent 8092** / Python RAG 8091）中的 Agent 服务：需求访谈、线框、planner→coder→reviewer 工作流、SSE 直连浏览器。权威设计见 `../docs/ts_agent/architecture.md`，实施票据见 GitHub Issues（父 #1）。

## 运行

```bash
npm install
cp .env.example .env   # 按需修改 PORT / JWT_SECRET / WORKSPACE_ROOT
npm run dev            # 端口 8092
```

## 测试

```bash
npm test         # vitest 一键运行（真实服务实例 + fastify.inject + 自签 JWT）
npm run type-check
```

## 路由

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 健康检查，`{"status":"ok"}` |
| `POST /agent/workspace/validate` | JWT | body `{"workspacePath":"<绝对路径>"}`；不逃逸 `WORKSPACE_ROOT` → 200，否则 400 |
| `GET /agent/smoke/sse` | JWT | 冒烟端点：按新 SSE 格式输出六类脚本化事件 |

## 鉴权约定

- HS256 共享密钥（`JWT_SECRET`）：Java 登录时签发短时 JWT（签发在 #12 落地），Agent **离线验签不回查 Java**。
- `exp` / `sub`（用户 id）必备；算法白名单锁死 HS256。
- `/agent/*` 无令牌 / 格式错误 / 验签失败 / 过期 → 401。

## SSE wire 格式（#5 定稿前的工作约定）

- 帧 = `event: <类型>` + `data: <单行 JSON>` + 空行；多行内容逐行拆分为多个 `data:` 行。
- 事件类型：`ai_response` / `ai_thinking` / `tool_request` / `tool_executed`（字段语义与旧契约对齐）+ `milestone` / `done` / `error`。

## 代码结构

```
src/
  config.ts            # 环境配置（PORT/JWT_SECRET/WORKSPACE_ROOT）
  events.ts            # 六类 SSE 事件模型
  sse/format.ts        # SSE 帧序列化
  auth/jwt.ts          # jose 离线验签
  auth/plugin.ts       # /agent/* 鉴权作用域（钩子不外溢）
  workspace/sandbox.ts # 工作区沙箱校验（移植自 Python Agent workspace/manager.py）
  routes/              # healthz + agent 路由
  app.ts               # buildApp（生产与测试共用）
  index.ts             # 入口
test/                  # vitest：healthz / 鉴权矩阵 / 沙箱逃逸 / SSE 顺序
```
