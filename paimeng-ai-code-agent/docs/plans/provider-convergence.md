# 生成模型配置与 harness

状态：已集成产品库模型域，验证进度见 [本轮验收](./provider-redis-convergence.md)。生成由常驻 harness 执行，Next 负责鉴权、任务准入和 attach；生成模型默认来自管理端配置的 `codegen.default`。

## 每轮模型准入

1. Next 调用 harness `POST /model`。harness 一致读取产品库模型配置，检查别名与提供商已启用、格式和凭据来源有效，并固定这轮的模型描述。
2. 返回公开身份、图片能力、思考档位和不透明 binding token。响应不含密钥或密文。
3. Next 校验图片、附件与产品准入，再将 token 交给会话创建和 `/submit`。预检与提交之间改配置不会更换本轮绑定。
4. 后续运行重新解析配置；忙碌会话收到不同 token 时返回 409，不修改 provider 目录或会话配置。插话和修复轮沿用当前绑定。

未配置/禁用的别名、密文无法解密、未允许的环境变量或不支持的 API 格式，会在任务落库前返回可读的 503。harness 可以在配置尚未完成时启动；不会因此静默选择另一模型。

## 来源优先级与凭据

| 来源 | 使用条件 | 凭据处理 |
| --- | --- | --- |
| harness 夹具 | 显式 `DURABLE_FAUX_FIXTURE=1` 或 `DURABLE_FAUX_MODEL=1` | 不访问真实上游；生产还要求 `ALLOW_TEST_FIXTURE=1` |
| 环境覆盖 | `DURABLE_MODEL_BASE_URL` / `_API_KEY` / `_ID` 三项完整设置 | 密钥只由 auth 回调读取；部分设置直接报错 |
| 产品模型域 | 默认路径，解析 `codegen.default` | inline 用 `decryptModelSecret`；env 经白名单检查后读取 `process.env` |

`npm run dev` 不再读取其他工具的模型配置文件。提供商 inline 密钥只以密文保存在 `model_provider`，解密使用 `MODEL_SECRET_KEY` 或已有的本地主密钥文件。明文不进入 `AliasModel`、HTTP 载荷、会话文档、日志或文件。

普通运行在内存 auth 闭包中保留准入时的 inline 密文，请求时才解密，因此轮换提供商密钥不会改变正在执行的运行。持久描述不包含该密文；重启恢复时按原提供商的凭据引用读取当前可用密钥。原凭据来源不存在时明确失败，不改用当前别名的提供商。

## 协议与思考设置

| 产品 API 格式 | pi-ai API | 地址约定 |
| --- | --- | --- |
| `openai-chat` | `openai-completions` | `{baseUrl}/chat/completions` |
| `openai-responses` | `openai-responses` | `{baseUrl}/responses` |
| `anthropic-messages` | `anthropic-messages` | 产品地址末尾的 `/v1` 由适配器归一，避免重复 `/v1/v1/messages` |

请求使用提供商自定义 headers 和别名 modelName、reasoning，输出预算来自别名设置。通用 OpenAI Chat 不附带 DeepSeek 的 thinking 字段；显式设置 `thinkingSwitch` 时按保存值强制开启/关闭。关闭优先于 alias reasoning，开启且未指定强度时只发送开启指令。

价格、上下文窗口等模型元数据暂时沿用原 harness 默认值；产品表没有这些字段。本次不新增模型目录或推断价格/上下文预算。

## 重启与记账

每轮公开描述保存在 pi-durable 会话文档 `app.run-model`：原 providerId、模型引用、地址、API 格式、请求头、设置、能力和凭据引用。没有明文或密文，不新增产品表。

恢复不重新解释当前别名：即使别名已改指 P2，旧运行仍按原 P1 的描述重建。已结束模型循环的会话也可通过只读 `GET /model?conversationId=` 返回原身份，支持产品最终构建阶段的接管。显式环境覆盖恢复时同样使用持久引用里的模型与地址。

账目继续记录 alias、产品 providerId 与实际模型名；上游请求元数据另存。实时助手消息使用合法 SDK metadata 的 generationId 对应用量，刷新后的历史使用原助手条目 id。

## 类型分类仍在 Next

`createApp` 在创建应用前调用 `route.classify`，只返回一个结构化类型，不需要建立生成会话。因此保留现有 AI SDK 路径及同一模型注册表。它沿用 5 秒 TTL / refresh epoch；生成则每轮直接读取产品配置。

## 实现与验证落点

- 运行描述、凭据与适配：`src/server/durable/model-domain.ts`。
- 公开 HTTP schema：`src/shared/durable-model.ts`。
- 准入、持久化与恢复：`src/server/durable/harness-server.ts`。
- 产品任务、attach、记账与实时 metadata：`src/server/durable-engine.ts`。
- 请求契约单测：`tests/models/durable-model-domain.test.ts`。
- 热更新、忙碌拒绝、凭据隔离与重启：`tests/integration/durable-m1/model-config.test.ts`。
