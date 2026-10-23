# 模型分配：把「别名」收成固定槽位

界面上的「别名」暗示名字由管理员定，但代码只认四个写死的名字。本轮把这件事摆正：**槽位编号与用途由代码定义，界面只允许给每个槽位就近配一个模型，配错在保存时拦住。** 不动表结构，不做候选列表，不做故障转移。

> 候选列表与故障转移已决定延后，决策与续做前置条件记在文末「延后决策」。

## 现状（都已核对代码）

1. **管理员可以造出没有任何代码读的名字。** 新增别名的名称输入框在创建态可编辑（`model-manager.tsx:913`），服务端只校验格式不校验取值（`modelAliasNameSchema` = 通用标识符规则，`model-config.ts:67`）。造出来的行安静地躺在库里，不参与任何解析。
2. **能力是手填的，填错要到运行时才炸。** `requiredCapabilities`（`model-config.ts:288`）确实校验了两个必需别名的能力，但它是「库里声明的能力」对「业务要求」的比对，界面四个复选框全开可点，管理员关掉 `codegen.default` 的工具调用只会在保存时收到一句笼统的能力不符。
3. **界面心智模型与实现相反。** 页签叫「别名」，表格第一列是管理员自己起的名；真实语义是「四个固定用途各配一个模型」，其中两个必需、两个可选。用户看这一屏学不到「哪个槽位没配会导致什么」。

真实库当前只有 `codegen.default`（env-default/deepseek-flash）与 `route.classify`（zen-go/beam-free）两行，没有清单外的历史垃圾。旧安装可能有。

## 本轮范围

只改代码与界面，**不加表、不加迁移、不动 `model_alias` 行结构**。一槽位一模型，`alias` 主键本身就是槽位编号。

### 1. 槽位常量成为唯一真相

`src/shared/model-config.ts` 新增 `modelSlots`：每项声明 `slot`、`label`、`purpose`、`requires`（能力要求）、`optional`（未配是否允许）、`missingImpact`（没配会怎样，给界面用）。

现有的 `requiredModelAliases`、`optionalModelAliases`、`requiredCapabilities`、`aliasPurposeOf` 全部改为从 `modelSlots` 派生，保持导出名不变。

派生之外还有两处按别名名字写死能力的代码必须一并改掉，否则 `requires` 只是第四份真相：

- 初始化 seed（`models/store.ts:314`）：`alias === 'codegen.default' ? … : …` 改读 `modelSlots[alias].requires`。
- 注册表合成默认别名（`models/registry.ts:95`）：同一个三元，同样改读。

产品面调用签名不变：`resolveModel('codegen.default')` 等调用点零改动。

槽位清单不变：

| 槽位 | 名称 | 用途 | 必需能力 | 未配置时 |
| --- | --- | --- | --- | --- |
| `codegen.default` | 代码生成 | 生成与修复应用源码的主力模型 | streaming + toolCalling | 无法生成，界面报错 |
| `route.classify` | 类型路由 | 从需求里识别工程类型 | structuredOutput | 无法路由 |
| `version.summary` | 版本标题 | 给版本面板写 20 字标题 | 无 | 走 agent 原话兜底，不影响出图 |
| `speech.transcribe` | 语音转写 | 浏览器录音转文字 | 无 | 麦克风禁用并说明原因 |

### 2. 写入端白名单，读取端宽容

- 拒绝点放在写入路径（`models/store.ts` 的 `upsertAlias` 与 `applyMutation` 的 `upsertAlias` 分支）：槽位不在 `modelSlots` 里就 400，错误文案直接用该槽位的 `label` 说明「模型分配只有这四个槽位，不能自建」。
- **不能**把白名单塞进 `modelAliasInputSchema`：`aliasFromRow`（`models/store.ts:105`）对每一行都跑这个 schema，一旦历史库里有清单外的行，整个配置快照都会解析失败，管理页直接白屏。读取端必须继续容忍，只在界面上把清单外的行标成「未使用」。
- **也不能**把白名单加进 `modelConfigIssues`：`applyModelConfig`（`models/store.ts:279`）每次都对库里现有全部行跑一遍这个校验，删别名也走同一条路径。一条历史脏行会让之后每一次保存都 400，包括删掉它自己。白名单只校验本次写入的槽位名，`modelConfigIssues` 的行为与改动前逐条一致。
- 必需槽位仍不能删除（现有 `models/store.ts:170` 已拦），保持。

### 3. 能力要求由槽位声明，界面只读

- `requires` 从 `modelSlots` 派生，`modelConfigIssues` 的报错文案改成点名缺失能力（「代码生成槽位需要工具调用能力，当前提供商未勾选」）。
- 编辑必需槽位时，`requires` 覆盖的复选框置灰并附一行说明；管理员仍可勾选额外能力（`imageInput` 这类只影响个别模型的能力继续由管理员决定）。

### 4. 界面：页签改名「模型分配」，四张固定卡片

`model-manager.tsx` 的别名页签改造：

- **卡片列表由槽位常量生成**，左连 `config.aliases`：遍历 `modelSlots`，按 `slot` 找库里对应的行，找不到就渲染成「未配置」。现有表格直接喂 `config.aliases`（`model-manager.tsx:621`），库里没有的行不会出现。
- 卡片的名称与用途读 `modelSlots`，不再只读 `aliasPurposeOf`（它只认可选槽位，两个必需槽位返回 null，`model-config.ts:27`）。`admin.ts` 里那份 `requiredAliases` 名字数组改为直接下发槽位清单。
- 卡片内容：首行槽位编号（等宽字体）+ `label` 徽标 + 必需/可选标记；第二行 `purpose`；第三行当前指向（提供商 + 模型名）或「未配置」，未配置时显示 `missingImpact`。
- **操作列只有「配置」一个按钮**，不出现删除或清除入口。编辑弹窗里槽位编号只读展示，只剩提供商、上游模型名、能力、参数、启用；可选槽位在弹窗底部提供「清除分配」次级按钮，必需槽位没有。
- 去掉「新增别名」按钮与创建态的名称输入。
- 保留现有「可选槽位未配置」的一键预填逻辑（`model-manager.tsx:382`），文案从「新增别名」改为「配置该槽位」。

产品面完全不动：`resolveModel('codegen.default')` 等调用签名与行为都不变。

## 单元与顺序

| # | 内容 | 主要文件 | 验收 |
| --- | --- | --- | --- |
| U1 | `modelSlots` 常量，现有导出改为派生，两处名字三元改读 `requires` | `shared/model-config.ts`、`models/store.ts`（seed）、`models/registry.ts`（默认别名） | 现有导出名与类型不变；`npm test` 全绿；`modelConfigIssues` 对四槽位行为与改前逐条一致；单测钉住三条能力来源（槽位常量、seed、注册表默认别名）一致 |
| U2 | 写入端白名单 + 能力文案点名 | `models/store.ts` | 清单外槽位写入被 400 拒绝；历史脏行仍能读回快照；必需槽位缺能力报错点名具体能力 |
| U3 | 界面改模型分配 | `components/model-manager.tsx`、`models/admin.ts`（下发槽位清单）、`business.ts`（如需）、`admin-page.tsx` 文案 | 卡片由槽位常量生成，未配置的槽位也在；操作列只有「配置」；无新增别名入口；必需能力复选框不可取消；可选槽位有预填入口 |
| U4 | 测试补齐 | 单测、`tests/integration/model-store.test.ts`、`model-admin.test.ts`、`tests/e2e/admin-parity.spec.ts` | 见下 |

U4 用例：

- 单测：`modelSlots` 与三个派生导出的一致性；四个槽位的 `requires` 与 `requiredCapabilities` 结果相同；初始化 seed 与注册表默认别名产出的能力与槽位 `requires` 相同。
- 集成（改写既有用例）：`model-admin.test.ts:277` 与 `:387` 现在建 `extra.model` 再删掉它，白名单上线后这两处写入必然 400。改写为用可选槽位（`version.summary`）做写入与删除往返，`extra.model` 只保留在「被拒」用例里。
- 集成（新增）：`upsertAlias('extra.model')` 被 400 拒绝；`upsertAlias('codegen.default')` 关掉 toolCalling 被拒且文案含「工具调用」；库里手工插入清单外行后 `listModelConfig` 仍能返回，且该库仍能正常保存其它槽位（验证白名单没进 `modelConfigIssues`）。
- e2e：管理页「模型分配」页签显示四张卡；未配置槽位显示影响说明；操作列只有「配置」；不存在「新增别名」按钮。

## 验证门禁

`type-check` → `npm test` → 聚焦集成（`model-store`、`model-admin`、`model-registry-multiprocess`，其中 `model-admin` 必须有改写后的可选槽位往返用例通过）→ 全量 integration → `verify.mjs` 跑 `admin-parity` 页签旅程并归档证据到 `.pi/skills/verify-paimeng-agent/evidence/<timestamp>/`。不新增 E2E 端口约定，沿用 `E2E_APP_PORT=3020 E2E_PREVIEW_PORT=3021`。

关键旅程：

- 全新库初始化后，管理页四个槽位中两个已配置、两个显示「未配置 + 影响」。
- 把 `codegen.default` 指向一个不支持工具调用的提供商 → 保存被拒，提示点名工具调用能力。
- 清空 `version.summary` → 版本标题仍能生成（走 agent 原话兜底），管理页显示该槽位未配置。
- 生成一条版本 → 聊天页版本面板标题正常，行为与本轮改动前一致。

## 开放问题

1. **清单外的历史行**（旧安装可能有）：界面标「未使用」并在保存任意槽位时静默忽略，还是启动时打一条告警日志？建议前者，不引入启动噪音。
2. **是否留一个隐藏逃生口**（比如环境变量允许额外槽位名）：建议不留。真需要新槽位时改一行代码比留后门便宜。

## 延后决策：候选列表与故障转移

决定：本轮不做，等有真实的多模型需求再启动。原因不是成本，而是它要改三处现有机制，值不值得改应当由真实需求决定。

已定下的形态（续做时直接照这个走）：

- 数据形状：保留 `model_alias` 行结构，一个槽位下挂有序候选（候选子表，位 0 是主力），不合并成 JSON 文档。
- 切换粒度：只在 run 边界切换，跑过工具的那一轮失败不切。粘性：切过之后本次生成粘住该候选。
- 错误分类：429/5xx/超时/401/403/参数不支持可切；内容拒答、安全拦截、用户取消、上下文超长（v1）不切。
- 上限：候选不超过 3 个，一次生成最多切一次。

评审时已核出五个必须先解决的陷阱，记在这里免得续做时重踩：

1. **`model_slot` 表是多余的。** 槽位定义在代码里，再建一张表 seed 同样的事实会漂移；候选表只留 `slot` 列，由代码常量校验即可。
2. **重提会复制用户消息。** 引擎提交时把用户气泡一起交给 harness（`durable-engine.ts:1311`），切换后重新提交同一输入，转录里会出现两条一样的用户消息；必须有不回显 entry 的重试入口。
3. **「本轮跑过工具」的判据不能读累计值。** `turn` 在主循环外创建（`durable-engine.ts:511`），`tools` 与 `recordedModelSteps` 跨 run 累加，第二个 run 起必然非空，等于只有第一轮能切；要按 run 记计数。
4. **准入令牌是一次性捕获的。** `binding` 在开始观察前取一次（`durable-engine.ts:1303`），failover 签发的新令牌必须写回提交参数，否则静默退回主力。
5. **`imageInput` 必须挂在候选上，不能挂槽位。** 收图闸门读的就是它（`durable-engine.ts:1189`），而同一槽位下不同候选的视觉能力经常不一样。

## 实施记录

U1–U4 已按本计划落地，验证结果见下。两处比计划更彻底：

- `optionalModelAliases` 与 `aliasPurposeOf` 没有保留成派生导出。界面改成读槽位清单后没有任何调用方，留着就是死代码；槽位的名称与用途统一走 `modelSlots`。
- 管理端响应里 `requiredAliases`（名字数组）换成 `slots`（完整槽位定义）。界面不再自己拼名单，也不需要把槽位清单打进客户端包。

其余按计划执行：写入端按槽位名白名单拒绝自建（`models/store.ts` 的 `upsertAlias` 分支），白名单没有进 `modelConfigIssues`（老库脏行不阻塞保存，集成用例覆盖）；初始化 seed 与注册表默认别名两处名字三元改读 `capabilitiesForSlot`；能力报错点名缺失项（如「槽位代码生成（codegen.default）需要工具调用能力，当前未勾选」）。

验证：`type-check` 通过；单测 369/369；集成 232 过 / 1 跳过 / 0 失败；`verify.mjs` 跑 `model-manage` 10/10 与 `admin-parity` 5/5（证据 `.pi/skills/verify-paimeng-agent/evidence/2026-10-23T04-14-13/`）；管理页四张卡片的实际渲染另截图确认。
