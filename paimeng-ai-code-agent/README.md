# paimeng-ai-code-agent（TS Agent）

三服务架构（Java 8123 / **TS Agent 8092** / Python RAG 8091）中的 Agent 服务：需求访谈、线框、planner→coder→reviewer 工作流、SSE 直连浏览器。权威设计见 `../docs/ts_agent/architecture.md`，实施票据见 GitHub Issues（父 #1）。

## 运行

```bash
# 原生 Linux（当前宿主，2026-09-07 起；依赖与 esbuild 产物在服务目录，无需指定环境目录）
npm install --registry=https://registry.npmmirror.com
cp .env.example .env   # 按需修改 PORT / JWT_SECRET / WORKSPACE_ROOT
npm run dev            # 端口 8092（esbuild 打包 + watch 自动重启）
# WSL（依赖直接安装到 wsl-rt-env/ts-agent/，服务目录零 node_modules、零软链）
bash scripts/install-wsl-node-modules.sh
bash scripts/run-wsl.sh
# Windows/IDE：服务目录内直接 npm install，继续使用已有 npm 运行配置
```

> 运行、测试与类型检查：原生 Linux/Windows 用 `npm run <dev|start|build|test|type-check>`；WSL 宿主用 `bash scripts/run-wsl.sh <...>`（入口校验宿主）。内部经 `scripts/run.mjs` 按 `/proc/version` 是否含 `microsoft` 分流：WSL 用 `wsl-rt-env/`，原生 Linux/Windows 用服务目录默认位置，互不回退。

## 测试

```bash
npm run test         # 原生 Linux / Windows
npm run type-check
bash scripts/run-wsl.sh test         # 仅 WSL 宿主
bash scripts/run-wsl.sh type-check
```

## 路由

| 路由 | 鉴权 | 说明 |
|---|---|---|
| `GET /healthz` | 无 | 健康检查，`{"status":"ok"}` |
| `POST /agent/workspace/validate` | JWT | body `{"workspacePath":"<绝对路径>"}`；不逃逸 `WORKSPACE_ROOT` → 200，否则 400 |
| `POST /agent/interview` | JWT | 五维访谈（受众/风格/页面清单/数据需求/交互，每维 2-4 选项选择题），最多 2 轮、信息足够跳过；状态持久化于 run context |
| `POST /agent/wireframe` | JWT | 快速档线框：单文件 HTML（灰块/占位图/可点击跳转/站点地图，≤5 页），存 `{workspace}/wireframe/`，run → wireframe_pending；免费 + 每用户每日限频（超限 429） |
| `POST /agent/wireframe/confirm` | JWT | 确认线框 → run → wireframe_confirmed（codegen 布局契约；幂等） |
| `POST /agent/stream` | JWT | 生成流：XState 线性工作流 + Vercel AI SDK 假 LLM（provider + 工具循环）+ SSE；**线框闸门**——非 wireframe_confirmed 的请求在开流前被预检拒绝（400/409/503/402/502 错误 JSON，开流后失败仍以 error 事件收尾，见 contract.md「错误双轨」）；#8 起含 Guardrail 输入校验（拒绝→failed）、文件六工具 + 图片四工具（**图片配额 4 张/run**）、写盘前代码块解析、产物含应用内导览组件 |
| `GET /agent/smoke/sse` | JWT | 兼容性冒烟端点：按新 SSE 格式输出脚本化事件 |

## 鉴权约定

- HS256 共享密钥（`JWT_SECRET`）：Java 登录时签发短时 JWT（签发在 #12 落地），Agent **离线验签不回查 Java**。
- `exp` / `sub`（用户 id）必备；算法白名单锁死 HS256。
- `/agent/*` 无令牌 / 格式错误 / 验签失败 / 过期 → 401。

## SSE wire 格式（见 `../docs/ts_agent/contract.md`）

- 帧 = `event: <类型>` + `data: <单行 JSON>` + 空行；多行内容逐行拆分为多个 `data:` 行。
- 事件类型：`ai_response` / `ai_thinking` / `tool_request` / `tool_executed`（字段语义与旧契约对齐）+ `milestone` / `done` / `error`。

## 代码结构

```
src/                   # 按领域切分（#16：13 个技术层目录收敛为 6 个领域目录，零行为变更）
  server/              # 服务装配与横切面
    index.ts           # 服务入口（默认端口 8092，esbuild 打包锚点）
    app.ts             # Fastify 应用装配（buildApp，生产与测试共用）
    config.ts          # 环境配置（PORT/JWT_SECRET/WORKSPACE_ROOT/JAVA_INTERNAL_*/模型与图片渠道键；图片模型缺省值与第三方图片源常量归属此层）
    agentRoot.ts       # 服务根目录定位（AGENT_ROOT，提示词等资源解析）
    agentRoutes.ts     # agent 路由（工作区校验/访谈/线框确认/生成流/冒烟，含需求工程与 codegen 闸门；路由只做协议解析与 HTTP 翻译）
    httpError.ts       # HTTP 错误单点（#21）：httpError 工厂 + setErrorHandler 统一产出 {statusCode, error, message}
    healthzRoutes.ts   # 健康检查路由
    jwt.ts             # jose 离线验签
    authPlugin.ts      # /agent/* 鉴权作用域（钩子不外溢）
  protocol/            # wire 协议出口
    events.ts          # 七类 SSE 事件模型（AgentEvent）
    sse.ts             # SSE 帧序列化
  runs/                # 运行记录网关（原 internal/，名不副实故改）
    runClient.ts       # Java 内部 API 客户端（create/update/get/complete + 错误映射）
  interview/           # 需求理解域：访谈 → 线框 → 确认
    index.ts           # 五维访谈：题目生成/收敛判断/结论（选项表与人话结论单源，脚本化，真实模型替换点）
    conduct.ts         # 访谈编排（run 获取/创建、幂等重放、阶段冲突、轮次推进，#21 自路由归位）
    wireframe.ts       # 线框生成：单文件 HTML（站点地图 + 灰块 + 占位图，≤5 页）
    guardrails.ts      # 提示词安全输入护轨（长度/空/敏感词/注入模式，interview 阶段拦截）
    context.ts         # run.context JSON 类型化解析（interview + wireframe 状态）
  generation/          # 生成主链路域
    workflow/          # 工作流：驱动 + 状态机 + 输入滑窗
      index.ts         # 工作流驱动：XState actor 推进 + streamText 消费 + run phase 更新 + 工作区落盘
      machine.ts       # XState v5 线性工作流状态机（interview→coding→review→done/failed，milestone 聚合）
      history.ts       # 输入滑窗
    review/            # 质检三重门禁（质检分 / build 校验 / 视觉 diff 基准 = 已确认线框）
    tools/
      index.ts         # 工具注册表（文件六 + 图片四 → AI SDK tool 定义）
      fileTools.ts     # 文件六工具（写/读/改/删/列目录/退出 + 重要文件保护 + 沙箱）
      imageTools.ts    # 图片四工具（Pexels/Undraw/DashScope/mmdc + 配额 4 张/run）
    prompts/           # 提示词加载器（AGENT_ROOT 定位）+ 生产在用 2 份（codegen-html / code-quality-check；其余 5 份原件留档 rag 仓库）
    intensity.ts       # 三档强度（fast/standard/deep：maxTurns/maxOutputTokens/maxToolCalls/maxImages）
    workspace.ts       # 工作区沙箱校验（移植自 Python Agent workspace/manager.py）
  llm/
    index.ts           # 脚本化假 LLM：AI SDK LanguageModelV2 provider（customProvider 注册，零在线调用）
    real.ts            # 真实渠道（三渠道 OpenAI 兼容封装，渠道表驱动）
test/                  # 与 src/ 路径对称分包；helpers/fixtures 与跨域 golden e2e 留顶层
  server/              # 鉴权矩阵 / healthz / stream 契约 / smoke SSE
  protocol/            # SSE 帧编码
  runs/                # run 客户端
  interview/           # 护轨 / 需求工程（访谈 + 线框）
  generation/          # 强度 / 沙箱 / 质检门禁集成；workflow、tools、review 子目录随 src 同构
  llm/                 # 真实渠道离线单测
```
