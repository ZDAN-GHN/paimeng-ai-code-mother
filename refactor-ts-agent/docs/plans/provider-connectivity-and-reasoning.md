# 提供商连通性检测、模型列表下拉与思考（thinking）配置

状态：待评审。改动范围仅 `refactor-ts-agent/`。

## 背景

用户当前开发库配置（截图确认，`paimeng_ai_code_mother_ts`，数据库配置版本 3）：provider `env-default`「DeepSeek官方」/ API 格式 `openai-responses` / 地址 `https://api.deepseek.com` / 密钥来源「直接输入密钥」；别名 `codegen.default`、`route.classify` → 上游模型名 `deepseek-flash`。

三个诉求：

1. 提供商弹窗增加「测试端点是否可用」。
2. 问 AI SDK 能否配置思考（thinking）字段——DeepSeek 的推理字段与普通 OpenAI 不同。
3. 别名弹窗的「上游模型名」希望能拉取可用模型、下拉选择，并且手动输入时支持筛选。

## 调研结论（依据本机 node_modules 与上游官方文档）

### AI SDK 的思考配置能力：支持，且是统一入口

- 统一调用参数 `reasoning`：`'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`（`node_modules/@ai-sdk/provider/dist/index.d.ts:1545`）。
- 各 provider 把它翻译成上游字段：
  - `openai-chat`（`@ai-sdk/openai-compatible@3.0.65`）→ `reasoning_effort`（`node_modules/@ai-sdk/openai-compatible/dist/index.js:438`，判定函数 `isCustomReasoning` 见 `@ai-sdk/provider-utils/dist/index.js:2025`）。
  - `openai-responses`（`@ai-sdk/openai@4.0.91`）→ `reasoning.effort`（`node_modules/@ai-sdk/openai/dist/index.js:6124`；provider 选项 `reasoningEffort` 取值 `dist/index.d.ts:52`）。
  - `anthropic-messages`（`@ai-sdk/anthropic@4.0.78`）→ thinking 预算：`dist/index.js:5417` 调 `mapReasoningToProviderBudget`（`@ai-sdk/provider-utils/dist/index.js:2072`：`min(maxReasoningBudget, max(1024, round(maxOutputTokens × pct)))`）；另有 provider 选项 `thinking`、`sendReasoning`（`dist/index.d.ts:246`）。
- 响应侧：DeepSeek 的思维链在 `reasoning_content`，`@ai-sdk/openai-compatible` **已原生解析**（非流式 `dist/index.js:473-477`、流式 `:641-658`，暴露为 `reasoning` 内容块）→ **不需要** `extractReasoningMiddleware`（那是给把推理写进正文标签的模型的，`node_modules/ai/dist/index.d.ts:9346`）。
- `defaultSettingsMiddleware({settings})` 的 settings **不含** `reasoning`（`node_modules/ai/dist/index.d.ts:9297-9314`），而 `wrapLanguageModel` 接受 middleware 数组（`:9418-9422`）→ 用一个极小的自定义 middleware 注入 `params.reasoning`。

### DeepSeek 侧事实（官方文档）

- `GET https://api.deepseek.com/models` 可列出可用模型（<https://api-docs.deepseek.com/api/list-models>）。
- DeepSeek **已支持 Responses API**，`base_url` 同样是 `https://api.deepseek.com`，模型为 `deepseek-flash` / `deepseek-v4-pro`（<https://api-docs.deepseek.com/guides/responses_api>）→ 用户当前的 `openai-responses` 选择是有效的。
- 思考控制参数（<https://api-docs.deepseek.com/guides/thinking_mode>）：
  - Chat/OpenAI 格式：开关 `thinking: {"type":"enabled"|"disabled"}`，强度 `reasoning_effort: "low"|"high"|"max"`。
  - Responses 格式：`reasoning: {"effort":"none"|"low"|"high"|"max"}`（`none` 即关闭）→ **正好等于 SDK 的 `reasoning`/`reasoningEffort` 输出**。
  - Anthropic 格式：地址为 `https://api.deepseek.com/anthropic`，强度用 `output_config.effort`。

结论：Responses 路径只要设 `reasoning` 就能控制 DeepSeek 的思考强度；Chat 路径 SDK 只发 `reasoning_effort`，开关需要在请求体里追 `thinking` 对象，`@ai-sdk/openai-compatible` 的 `transformRequestBody` 正好可以做（`dist/index.d.ts:104`）。

## 设计

### A. 提供商连通性检测

- 新增 `refactor-ts-agent/src/server/models/probe.ts`：
  - `fetchProviderModels(provider, apiKey)`：`GET {baseUrl 去尾斜杠}/models`；请求头按格式：`openai-chat` / `openai-responses` → `Authorization: Bearer <key>`，`anthropic-messages` → `x-api-key: <key>` + `anthropic-version: 2023-06-01`；`AbortSignal.timeout(10000)`、`redirect: 'manual'`。
  - 解析 OpenAI/DeepSeek 的 `{data:[{id}]}` 与 Anthropic 的 `{data:[{id,display_name}]}`，归一为 `{ id, label }[]`。
  - 错误归一化（不含密钥、不含 Authorization 头）：网络/超时/TLS → 「无法连接上游（原因）」；401/403 → 「上游拒绝了这个密钥」；404 → 「该地址没有 /models 接口」；其它 → 「上游返回 <status>」+ 截断 200 字符的响应片段。
  - 密钥解析复用 `store.ts` 的既有语义：`inline` 且表单留空 → 用库里 `apiKeyCiphertext` 解密；`env` → 允许名单 + `process.env`；全程不回显。
- 新接口 `POST /api/model/admin/provider/models`（admin-only，与 `model/admin/*` 同组）：入参 `{ provider: modelProviderWriteSchema }`，返回 `{ models: {id,label}[] }`；地址规则沿用 `modelBaseUrlIssue`（HTTPS 默认放行，HTTP 必须命中 `MODEL_INTERNAL_BASE_URL_ORIGINS`）；上游失败 → 502/50200，入参非法 → 400/40000。
- `refactor-ts-agent/src/components/model-manager.tsx` 提供商弹窗加「测试连接」按钮：成功显示「连接正常，共 N 个模型」+ 前 20 个 id；失败显示上述脱敏原因；测试中按钮 loading。

### B. 上游模型名下拉（可筛选、可手输）

- 别名弹窗「上游模型名」改用 antd `AutoComplete`（自带输入 + 筛选，无需新依赖）：默认仍是自由输入，旁边加「获取模型」按钮，调用同一接口填充选项（`value = id`，`label = display_name（id）`，有 display_name 时）；输入即筛选；失败提示与 A 一致。
- 拉取结果只存在对话框 state，不落库、不写 Redis、不改 DB schema。

### C. 思考（thinking）配置

- 别名新增「思考强度」选择，存 `alias.settings.reasoning`（`src/shared/model-config.ts:119` 的 `aliasSettingsSchema` 增加该可选枚举）：`不指定`（默认，不传）/ `关闭 none` / `最低 minimal` / `低 low` / `中 medium` / `高 high` / `更高 xhigh` / `最高 max`。
- `src/server/models/adapters.ts` 增加 `reasoningMiddleware`，与既有 `defaultSettingsMiddleware` 组成 middleware 数组（`:85`）：把 `params.reasoning` 设为别名配置值；各格式按上表自动映射（chat → `reasoning_effort`，responses → `reasoning.effort`，anthropic → thinking 预算）。
- 提供商新增命名兼容选项（仅 `openai-chat`，加入 `providerOptionKeysByFormat`，`src/shared/model-config.ts:69`）：`thinkingSwitch: 'none' | 'enabled' | 'disabled'`，默认 `none`。非 `none` 时用 `transformRequestBody` 追 `thinking: {type: 'enabled'|'disabled'}`，即 DeepSeek Chat 格式的思考开关。
- 文档写清映射表、DeepSeek 三种格式的对照，以及「上游不支持的等级会被拒绝」。

## 实施清单

- [x] 1. `src/shared/model-config.ts`：`reasoningLevels` + 中文标签、`thinkingSwitchValues`、`providerOptionKeysByFormat['openai-chat']` 增加 `thinkingSwitch`、`aliasSettingsSchema` 增加 `reasoning`。
- [x] 2. `src/server/models/probe.ts`（新）；`src/server/models/admin.ts` 暴露 `probeProviderModels(raw)`。
- [x] 3. `src/app/api/[...path]/route.ts`：新增 `model/admin/provider/models`。
- [x] 4. `src/server/models/adapters.ts`：`reasoningMiddleware` + 按格式注入 + `thinkingSwitch` 的 `transformRequestBody`。
- [x] 5. `src/components/model-manager.tsx`：测试连接按钮、AutoComplete、思考强度选择、按格式显示的 `thinkingSwitch` 选项。
- [x] 6. 测试：`tests/models/probe.test.ts`（新；本地 stub 服务覆盖三格式请求头/路径、401/404/超时、脱敏不回显）、`tests/models/adapters.test.ts`（三格式 reasoning 请求体 + `thinkingSwitch` 注入）、`tests/model-config.test.ts`（新 schema 与别名 settings）、`tests/integration/model-admin.test.ts`（新接口匿名 401 / 成员 403 / 非法地址 400 / 上游失败 502 / 成功列表 / 视图不回显密钥）、`tests/e2e/model-manage.spec.ts`（按钮与下拉渲染、失败提示）。
- [x] 7. 文档：`README.md`、`docs/implementation-contract.md`（新接口与新设置）、`docs/model-routing.md`（思考映射表 + DeepSeek 说明）、本计划文件。

## 本轮执行结果（2026-10-12/13）

| 实施项 | 结果 |
| --- | --- |
| 1–5 代码 | 全部落盘；`npx tsc --noEmit` 与 `npm run type-check` 均通过 |
| 6 测试 | `tests/models/probe.test.ts` 5 项；`tests/models/adapters.test.ts` 15 项；`tests/model-config.test.ts` 23 项；`tests/integration/model-admin.test.ts` 20 项；`tests/e2e/model-manage.spec.ts` 7 项 |
| 7 文档 | README「模型统一管理」、`docs/implementation-contract.md`（接口表 + 选项/思考/密钥/探测语义）、`docs/model-routing.md`（选项白名单、探测接口、思考映射表、模块清单） |

| 验证步骤 | 命令 | 结果 |
| --- | --- | --- |
| 1 | `npm run type-check` | 通过 |
| 2 | `npx vitest run tests/models tests/model-config.test.ts tests/integration/model-admin.test.ts` | **6 files / 94 tests passed**（3.34s） |
| 3 | `npm test` | **256/257 passed**，两次全量各有一项真实容器构建用例超时（见下），单独运行均通过 |
| 4 | `npm run build` | 通过（11 条路由含 `/admin/modelManage`） |
| 5 | `E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated -- tests/e2e/model-manage.spec.ts` | **7 passed (14.5s)** |
| 6 | `git diff --check` | clean |

实测修正记录（都不是靠猜）：

1. **`openai-responses` 的思考参数需要 provider 选项**：只设统一 `reasoning` 时 SDK 会丢弃该字段（`@ai-sdk/openai` 只认已知推理模型的 `openaiOptions?.reasoningEffort`），本地 stub 抓包确认必须走 `providerOptions.openai = { reasoningEffort, forceReasoning: true, reasoningSummary: null }` 才能发出 `reasoning:{effort}`。
2. **探测错误片段会泄漏密钥**：测试先失败于「上游返回 500：boom sk-probe-secret」，改为用当前密钥对片段做替换后再截断。
3. **别名弹窗没有落点显示探测失败**：`probeText` 原本只渲染在提供商弹窗，别名「获取模型」失败只有 toast，E2E 因此在对话框内找不到文案；现已在「上游模型名」下方显示，并让别名弹窗打开时清空上次的探测结果。
4. **antd v6 的两处废弃属性（只在 dev 模式告警，生产构建看不到）**：`<Space direction="vertical">` 已废弃 → `orientation="vertical"`（`src/components/model-manager.tsx` 共 4 处：499/719/739/927）；`Input` 的 `addonAfter` 已废弃（`node_modules/antd/es/input/Input.js:49`）→ 用 `Space.Compact` 包住 `AutoComplete` 与「获取模型」按钮。复核方式：隔离副本 + 真实 `next dev --port 3020`（测试库）+ Playwright 捕获 `console` 的 warning/error，修复后只剩预期的 401（未登录时的会话检查）与 502（故意指向不可达上游的探测）。
5. **本机/局域网 HTTP 地址不再要求部署显式允许（2026-10-13 追加，用户实测自建网关 `http://127.0.0.1:8787/v1` 被地址校验拦下）**：`modelBaseUrlIssue` 现在对本机与局域网字面量（`localhost`/`*.localhost`、`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`::1`、`fe80::/10`、`fc00::/7`）直接放行，判定只看字面量、不解析域名、不含 `169.254/16`；其它 `http:` origin 仍须写进 `MODEL_INTERNAL_BASE_URL_ORIGINS`。

### 全量测试的两项负载性超时（与本计划改动无关）

两次 `npm test`（日志 `runtime/provider-connectivity/npm-test.log`、`npm-test-final.log`）都是 `34 files / 257 tests`，各只有一项失败，且都发生在**真实 Docker 构建**用例上：

| 运行 | 失败用例 | 原因 | 单独运行结果 |
| --- | --- | --- | --- |
| 第一次 | `tests/integration/agent-vue-build.test.ts` | 测试自身预算 `180000ms` 用尽（整机负载下容器内 `npm install` 变慢） | `npx vitest run tests/integration/agent-vue-build.test.ts` **1 passed（137.58s）** |
| 第二次 | `tests/templates.test.ts`「未经 AI 修改的示例通过真实 Docker 类型检查与构建…」 | 产品侧容器命令预算 `src/server/artifacts.ts:37` 的 `timeout = 180000` 到期，报「构建超时」 | `npx vitest run tests/templates.test.ts` **12 passed（92.68s）** |

据此把 `tests/integration/agent-vue-build.test.ts` 的测试预算从 `180000` 提到 `300000`（与先前 `tests/artifacts.test.ts` 的处理一致）。**产品侧 180 秒容器预算没有改动**：它可能对负载较高或网络较慢的部署环境偏紧，属于本次计划之外的独立问题，留给用户决定是否放宽。

## 验证步骤

1. `npm run type-check`
2. `npx vitest run tests/models tests/model-config.test.ts tests/integration/model-admin.test.ts`
3. `npm test` 全量
4. `npm run build`
5. `E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021 npm run test:e2e:isolated -- tests/e2e/model-manage.spec.ts`
6. `git diff --check`

## 风险与未决

- 不是所有兼容网关都实现 `/models`（返回 404 时提示「该地址没有 /models 接口」，手动输入不受影响）。
- SSRF 面：仅管理员可用，沿用地址规则（HTTPS 默认放行、HTTP 内网需 `MODEL_INTERNAL_BASE_URL_ORIGINS` 显式放行）、10 秒超时、不跟随重定向、错误不回显密钥。
- 「测试连接」只验证地址 + 密钥（能列模型），不保证所选模型/格式真能推理；如需更强的「测试模型」（发一次 `maxOutputTokens: 1` 的真实请求并显示是否返回 reasoning）可作为下一步。
- `thinkingSwitch` 只实现 DeepSeek 的 `thinking:{type}` 形状；其它厂商（如 Qwen 的 `enable_thinking`）需要各自命名配置。
- 本次无新迁移（沿用 007 已加的可空 `apiKeyCiphertext`；`reasoning` 存在既有 JSON `settings` 里）。执行前需确认开发库仍是 `007` 已应用状态。

## 需要确认

1. 是否按本计划一次做完 A（测试连接）+ B（模型下拉）+ C（思考配置）？
2. 是否要额外增加「测试模型」（真实 1-token 调用，能验证所选模型与格式真的可推理）？
3. 思考强度选项是否要按格式收窄（例如 DeepSeek Responses 只支持 `none/low/high/max`），还是保持 SDK 全集、由上游自行拒绝？
