# 模型 provider 收敛：现状与 A/B 取舍

> 归档：记录当时的设计、迁移与验收。当前行为见[部署说明](../pi-durable-deployment.md)与[模型配置](../provider-convergence.md)。

状态：**设计稿，待用户决策**（2026-10-18，基线 `076f022`）。本文只做调研与方案对比，不含代码改动。
相关：库表职责见 [database-inventory.md](../database-inventory.md)，harness 部署与「两份凭据」缺口见
[pi-durable-deployment.md](./pi-durable-deployment-notes.md) §1（「需要显式决定的重复来源」）。

## 0. 一句话结论

生成链路的模型**不是**由产品库的模型管理配置决定的，而是由 harness 进程的 `DURABLE_MODEL_*` 环境变量决定的；
产品库里的 `model_provider` / `model_alias` 对生成只起「记账身份 + 图片能力门禁」作用。要收敛只有两条路
（A：harness 直接读产品库模型域；B：产品在每轮把绑定下推给 harness），**推荐 A 的分步路径**：
先修两处无论选哪条都要修的错（§7 S1），再让 harness 从产品库解析别名。

## 1. 现状：三样东西要分开看

| 东西 | 状态 | 证据 |
| --- | --- | --- |
| Vercel AI Gateway（托管网关服务） | **从来没接** | `package.json` 无 `@ai-sdk/gateway`，无任何 gateway 路由/变量；provider 表里的 baseUrl 全是用户自己填的上游 |
| Vercel AI SDK（`ai` 包 v7 + `@ai-sdk/*`） | 还在用，但真实上游调用只剩一处 | 生成**不再**经它；实调用是路由分类 `model.ts:57-66`（`generateText` + `Output.object`）。其余用途：`models/adapters.ts` 构造 `LanguageModel`（供身份、能力与语音取 baseUrl/密钥）、`web-access/tools.ts` 的 `tool()` 定义、`durable-engine.ts` 的 `createUIMessageStream`、前端 `DefaultChatTransport` |
| harness 侧的 pi-ai provider 层 | **生成链路真正在跑的那套** | `durable/harness.ts:29` `createProvider` + `withOpenCodeSessionHeader(openAICompletionsApi())`；凭据来自 `DURABLE_MODEL_BASE_URL/_API_KEY/_ID`（`harness.ts:38-41`），本机由 `scripts/durable-dev.ts:59-68` 从 `~/.pi/agent/models.json` 的 `oc-go` 派生，默认模型 id `deepseek-v4.1-flash` |

**决定性的证据**在自己的记账表里（`generation_step` 最新几行）：

```
model_alias       = codegen.default        -- 来自产品库别名表（身份字段）
provider_id       = durable                -- 来自 harness 条目上报（真实调用方）
upstream_provider = durable
upstream_model_id = deepseek-v4.1-flash    -- 实际跑的模型
```

即：`model_alias` 赢了「身份与门禁」，`DURABLE_MODEL_*` 赢了「实际请求」。

## 2. 现在的三个后果

1. **管理端改 `codegen.default` 的提供商/模型对生成无效**：别名解析（`model.ts:42` → `models/registry.ts`）仍会执行、
   仍会解密密钥、仍会按 `capabilities.imageInput` 拒绝不支持视觉的模型（`durable-engine.ts` 生成前的 400 校验），
   但返回的 `LanguageModel` 对象在 durable 模式下**只用于身份字段**，不会被调用。`pi-durable-deployment.md:147` 已把这条记为缺口。
2. **别名里的 `settings.reasoning` 对生成无效**：DB 里 `codegen.default.settings = {reasoning: "max"}`，而 harness 两处
   建会话都硬编码 `thinkingLevel: "off"`（`harness-server.ts:527`、`:673`，`durableModel()` 的 `thinkingLevelMap` 把 `off` 映成不发思考字段）。
3. **凭据两份**：产品库密文（`MODEL_SECRET_KEY` / `runtime/model-secret.key` 解密）与 harness 的 `DURABLE_MODEL_API_KEY`
   互不相干，部署时是两处独立的密钥管理。

## 3. pi-ai 已有的 provider 能力（不用重造的部分）

翻了 `node_modules/@earendil-works/pi-ai` 与 `pi-durable` 的类型与实现：

- **provider 注册与替换**：`createModels()` → `MutableModels.setProvider/deleteProvider/clearProviders`（`pi-ai/dist/models.d.ts:200-203`）；
  `createProvider` 支持单个 `api` 流实现，也支持按 `model.api` 分发的 map（同一个 provider 混合格式）。
- **鉴权**：`ProviderAuth` 里 `apiKey.resolve()` / OAuth 可异步、可刷新；API key 也支持 OAuth 与环境凭据。
- **模型目录**：`getModels()` 静态目录 + `refreshModels()`/`ModelsStore` 持久化刷新（对我们无用，我们自己的 DB 就是目录）。
- **API 格式**：`pi-ai/dist/api/` 下有 30 多个 api 模块，含我们三种格式的 lazy 版本
  `openai-completions` / `openai-responses` / `anthropic-messages`（另有 google-generative-ai、google-vertex、
  bedrock-converse-stream、mistral-conversations、cloudflare-*、openrouter-images 等）。
- **每模型元数据**：`thinkingLevelMap`（思考档位 → 上游字段）、`cost`（价格）、`contextWindow` / `maxTokens`、
  `compat`（如 `thinkingFormat: "deepseek"`、`requiresReasoningContentOnAssistantMessages`）。
- **会话级 agent 状态可改**：`Conversation.configure(change, context)`（`pi-durable/dist/harness/types.d.ts:588-600`，
  实现 `harness/agent.js:55`），字段 `model` / `thinkingLevel` / `extensions` / `tools` / `modelTools` / `instructions` / `cwd`，
  存在会话的 `pi.agent` 文档里。**产品已经在用这个口子**下发每轮 `instructions`（`harness-server.ts:751` 的 `POST /configure`
  ← `durable-engine.ts:224` `configureHarnessInstructions`）。
- **一轮内固定、跨轮生效**：`generation.js:28` 注释与 checkpoint 结构说明「agent 与 settings 在此解析，本请求内固定」，
  模型在每次请求/续跑时用 `models.getModel(provider, modelId)` 查（`generation.js:36,112,147,180`）。
  → **运行中 `configure` 改了模型，从下一轮开始生效**；反过来说，进程重启后 `resume()` 能用已持久化的
  `ModelRef` 继续跑，前提是那个 provider 在当前进程里注册过。

## 4. 方案 A：harness 直接读产品库的模型域

**做法**：harness 进程按 `model_provider` / `model_alias` / `model_config_state` 三张表解析别名 → 注册 provider →
每轮 `conversation.configure({ model, thinkingLevel })`（或建会话时给 `agent.model`）。

- 复用条件已经具备：harness 启动时本来就要读产品 env（`webToolsForConfig()` → `getConfig()`，见 deployment.md §1
  「产品 env 必须在 harness 的环境里合法」），`DATABASE_URL` 可用；`MODEL_SECRET_KEY` 同一台机器上也能读到
  （多实例部署时 deployment.md 已要求共享）。
- 热更新复用现成机制：`model_config_state.refresh_epoch` 变了就重建 provider 目录并把变化推给活跃会话
  （对齐 `models/registry.ts` 的 5s TTL / 60s 降级语义）。
- 重启续跑安全：密钥随时可从 DB 重新解密，`resume()` 恢复的任务能找到 provider。
- 风险：harness 从此依赖产品库 schema。把耦合限制在一个只读小模块里（三张表、三个函数：读快照 / 读 epoch / 解密密钥），
  并注意 `src/server/db.ts` 的注释——产品池把 int8 留字符串，而 harness 存储自己的连接把 int8 当数字，
  两套解析器不能混（模型域没有 int8 列，风险低但仍要显式复用产品池而不是 harness 的那个 client）。
- 改动点（预估）：新增 `src/server/durable/model-domain.ts`（读快照 + 组装 pi-ai provider/model 列表）；
  `harness.ts` 的 `durableModels()` 从「env 单 provider」改成「DB 多 provider + env 兜底」；
  `harness-server.ts` 建会话/`POST /configure` 处带上 `model` 与 `thinkingLevel`；`api_format → pi-ai api` 的映射表
  （`openai-chat → openai-completions`、`openai-responses → openai-responses`、`anthropic-messages → anthropic-messages`）。

## 5. 方案 B：每轮把绑定下推给 harness

**做法**：产品侧仍是唯一真源；扩展 `POST /configure`（或 `/submit`）让它同时接收
`{ provider: { id, baseUrl, apiKey, apiFormat }, model: { modelId, thinkingLevel } }`，harness 现场
`models.setProvider(createProvider(...))` + `conversation.configure({ model, thinkingLevel })`。

- 优点：harness 保持「不认识产品库」的执行器；产品侧唯一真源，改动集中在 HTTP 契约。
- 硬伤一（重启续跑）：进程重启后 provider 不在表里，而 `resume()` 恢复的生成有持久化的 `ModelRef`，
  查不到就报 `Model ... is not available`（`generation.js:36-39`）。要补就得在 harness 侧也存一份绑定与密钥
  （等于走回 A 的一半），或回退 env（等于现状）。
- 硬伤二（密钥暴露面）：harness 的 HTTP 服务目前**没有鉴权**、默认只监听 `127.0.0.1`（`harness-server.ts:70`），
  `durable/harness.ts` 头部注释也承诺「secrets never logged，never written to disk」——下推密钥会破坏这条，
  需要新增：不落日志（`log()` 与错误路径都要脱敏）、生产环境改用同机 unix socket 或 TLS，且密钥只驻内存。
- 硬伤三（并发）：多实例或多个 Next 进程时，每次 generation 都要 upsert provider，需要幂等与清理策略。

## 6. A / B 对比

| 维度 | A（harness 读产品库） | B（每轮下推） |
| --- | --- | --- |
| 单一真源 | 是 | 是 |
| 密钥暴露面 | 不新增（harness 读本机 DB + 本机密钥） | 新增（密钥经 HTTP 传给 harness，无鉴权服务） |
| 重启续跑 | 安全（随时可重新解析） | 不安全（要额外持久化绑定，或回退 env） |
| 热更新 | 复用 `refresh_epoch` | 每次 generation 都在推，天然最新 |
| 耦合 | harness 依赖产品库三张表（可用只读模块隔离） | harness 不认识产品库，但 HTTP 契约变大 |
| 改动量 | 中（新模块 + `durableModels()` 改写 + 两处 configure） | 小（HTTP 契约 + 每次 upsert provider） |
| 中途改模型 | 下一轮生效（框架语义） | 同 |

## 7. 推荐的分步路径

- **S1（无论选哪条都该做，独立可交付）**
  1. 模型管理页面对 `codegen.default` 加一句说明：**目前只影响图片能力校验与记账身份，实际模型由 harness 的
     `DURABLE_MODEL_*` 决定**（或直接把生成模型也做成 env 派生 + UI 只读）。避免「改了没生效」的错觉。
  2. 把 `thinkingLevel` 从硬编码 `"off"` 改成读别名的 `settings.reasoning`（映射表在 `durableModel()` 的 `thinkingLevelMap` 里已有）。
  3. 记账身份以**实际调用者**为准（`provider_id` 已经是 `durable`；`model_alias` 只能作「期望值」，别让两者混在同一列语义里）。
- **S2（选 A 时的最小实现）**：产品库模型域 → pi-ai provider 目录 + 每轮 `configure({ model })`；先只支持
  `openai-chat`（现网在用的那条），`openai-responses` / `anthropic-messages` 随后补。
- **S3**：能力（`capabilities.imageInput` / 工具调用）与思考档位改从同一处解析，产品侧的图片门禁与实际调用不再可能不一致。

## 8. 待决策问题

1. 选 A 还是 B？（本文推荐 A；若认为「harness 不读业务库」是必须守住的边界，则选 B 并接受 §5 的三条代价。）
2. 模型管理页面要对生成链路**真正生效**，还是明确降级为「路由分类 / 语音 / 探活」的配置？（现状是第二种，但 UI 没说明。）
3. `settings.reasoning` 要不要在 S1 就接通？（涉及成本与延迟，deepseek 系 `max` 明显更慢。）
4. `cost` / `contextWindow` / `maxTokens` 目前是 `durableModel()` 里的常量（0.15 / 0.6 / 0.003 / 0、1e6、32k），
   要不要进 DB？不进的话换模型后成本与上下文预算都是错的（用量块只展示 token，暂时不影响正确性）。
5. 生产部署时 harness 是否允许读产品库（A），或是否允许接收密钥（B）？对应 `MODEL_SECRET_KEY` 共享与 harness 服务加固。

## 9. 未验证项

- 运行中 `configure({ model })` 之后，**已经进入 `tools` 阶段**的那一轮是否真的按旧模型跑完（源码语义是 checkpoint 里固定，
  未在真实 harness 上跑过对照实验）。
- pi-ai 的 `createProvider` 在同一进程里注册多个 provider 并同时活跃（多会话用不同上游）的行为只在类型层面确认过，未实测。
- `models.setProvider()` 热替换时正在运行的请求是否安全（预期是：下一轮才查表，安全）。
