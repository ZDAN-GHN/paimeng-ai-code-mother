# paimeng-ai-code-agent（TS Agent）

TS Agent 的 SDK 宿主目录。旧的自研 Agent loop、XState 编排、会话事件存储、脚本化 LLM、评估链路和旧服务入口已清理，后续接入 DSH 或 Pi SDK 时在此目录重建唯一 Agent 宿主。

当前保留内容：

- `.env.example`、`package.json`、`package-lock.json`：配置与依赖声明
- `tsconfig.json`、`vitest.config.mjs`：工具配置
- `src/server/config.ts`、`src/server/agentRoot.ts`：运行配置基础
- `src/generation/tools/fileTools.ts`、`imageTools.ts`、`workspace.ts`：可复用业务工具和工作区安全边界
- `src/runs/runClient.ts`：Java run、计费和完成回调客户端
- `src/protocol/`：浏览器协议类型和 SSE 编码基础
- `src/server/healthzRoutes.ts`、`httpError.ts`、`jwt.ts`：服务基础设施

SDK 宿主重新落地前，`npm run dev`、`npm run build` 和 `npm run test` 不作为可运行性保证；这些命令的脚本声明暂时保留，便于后续实现接入。
