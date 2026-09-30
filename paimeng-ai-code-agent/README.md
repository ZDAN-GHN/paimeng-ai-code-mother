# TS Agent Runtime

本目录提供独立 Node.js / TypeScript Agent Runtime。使用 Node.js `24.20.0`，并通过本目录的 `package-lock.json` 锁定依赖。

## 命令

```bash
npm ci
npm run type-check
npm run test
npm run build
npm start
```

`npm start` 默认在 `127.0.0.1:8092` 提供 `GET /healthz`；可通过 `AGENT_PORT` 覆盖端口。

## 工作循环（Issue #80）

Agent 是拉取方：Platform 决定「现在该做什么」，本进程只凭 Platform 发出的凭据回报结果。工作循环默认关闭，开启时需要以下环境变量：

| 变量 | 作用 |
| --- | --- |
| `AGENT_WORK_LOOP_ENABLED` | 设为 `true` 才启动工作循环；关闭时行为与本特性之前完全一致 |
| `PLATFORM_BASE_URL` | Platform 基地址；受控执行端点只接受回环调用，因此应为回环地址 |
| `PI_AGENT_PROVIDER` / `PI_AGENT_MODEL_ID` | 归一化与受控执行共用的 provider 与模型 |
| `PI_AGENT_MODELS_PATH` | 可选的自定义模型配置文件 |

每轮领取一项工作：先领取归一化请求，没有待归一化项时才领取一个待启动的 `Run`。队列为空是空闲而不是错误；Agent 未部署、模型不可用或 Runtime 崩溃时，闭环都停在 Platform 已持久化的状态上。

归一化由一个独立的 core Agent 完成：它持有且仅持有一个 `submit_normalization` 工具，没有任何 Sandbox 工具，因此在 Owner 答复阻断问题之前不存在写入 Workspace 的路径。

## 当前边界

- Agent Engine 使用 `@earendil-works/pi-agent-core`；模型与 provider 流式协议使用 `@earendil-works/pi-ai`。不装载 Pi Coding Agent 的 TUI、CLI、扩展或宿主文件工具。
- `PiEngineAdapter` 为每个 Run 创建独立 core Agent；只挂载经 `SandboxOperations` 和 Platform fence 执行的 `read/edit/write/bash/find/ls` 六个工具。工具调用顺序执行，文件与命令均在 Sandbox 容器内。
- 模型配置由 Adapter 显式选定 provider/model；可通过 `authPath` 和 `modelsPath` 指定独立的凭据文件与自定义模型配置文件，不会读取用户或项目的 Pi 目录。自定义模型当前支持 `anthropic-messages`、`openai-responses` 与 `openai-completions` API；选中 provider 缺少目标模型或不支持的 API 会在启动 Run 前报错。
- `authPath` 必须是 POSIX 宿主上本进程持有的普通文件，权限为 `0600` 或更严格，不接受符号链接；部署前需限制凭据父目录权限。OAuth 刷新使用同目录的原子替换及 `.lock` 文件；进程异常退出遗留锁时须先核实没有持锁进程，再由运维处理，不自动删除未知锁。
- 自定义模型的 `apiKey` 可直接填写值或使用 `${ENV_NAME}` / `$ENV_NAME` 显式引用环境变量；未设置的变量不会作为字面量密钥发送。旧 SDK 的 `!命令` 形式不支持，会在启动 Run 前拒绝，防止在宿主机执行配置中的命令。
- `TaskExecutionBaseline` 由独立协议解析器验证；它不是通用 Agent Engine 输入。
- `PiEventNormalizer` 只把 Pi 原始事件转换为无业务 ID、Session、原始工具参数/结果或内部思考的 `AgentExecutionEvent`。
- `usage.observed` 是引擎原始用量观察；Runtime 按 Run 生成带业务 ID 的 Usage Evidence 并交给 Platform。用量事件从 core 的 `message_end` 读取，不转发 provider 错误正文。
- 测试直接读取 Java 的固定夹具，不复制或重新定义该契约。
- 每个调用引用可生成幂等的版本化 Usage Evidence；不包含价格、余额或积分操作。
- 当前 HTTP 服务只提供健康检查；Run 启动仍由 Runtime 与 Platform 合约驱动，不对外暴露通用 Agent 命令接口。
