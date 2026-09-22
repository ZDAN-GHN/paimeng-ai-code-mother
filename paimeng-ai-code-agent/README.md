# TS Agent 基线

本目录是 #76 的独立 Node.js / TypeScript Pi Adapter 基线。使用 Node.js `24.20.0`，并通过本目录的 `package-lock.json` 锁定依赖。

## 命令

```bash
npm ci
npm run type-check
npm run test
npm run build
npm start
```

`npm start` 默认在 `127.0.0.1:8092` 提供 `GET /healthz`；可通过 `AGENT_PORT` 覆盖端口。

## 当前边界

- 仅使用 `@earendil-works/pi-coding-agent` 作为 Agent Engine。
- `TaskExecutionBaseline` 由独立协议解析器验证；它不是通用 Agent Engine 输入。
- `PiEventNormalizer` 只把 Pi 原始事件转换为无业务 ID、Session、原始工具参数/结果或内部思考的 `AgentExecutionEvent`。
- `usage.observed` 是引擎原始用量观察；带业务 ID 的 Usage Evidence、幂等和持久化属于后续 Runtime 边界。
- 测试直接读取 Java 的固定夹具，不复制或重新定义该契约。
- 每个调用引用可生成幂等的版本化 Usage Evidence；不包含价格、余额或积分操作。
- 本阶段不会创建 `AgentEngineAdapter.execute()`、Pi Session、工具、Workspace、Sandbox、Lease、数据库、Production 或完整 Run Context。这些能力属于后续 T-05。
