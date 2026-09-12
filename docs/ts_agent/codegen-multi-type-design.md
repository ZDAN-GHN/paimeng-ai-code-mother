# 多类型代码生成迁移设计（multi_file / vue_project 接入 TS Agent）

> 状态：设计定稿（2026-09-09；经 agent-design-review 审查后按报告修订）。
> 关联：`docs/ts_agent/architecture.md` §5（生成物运行时阶梯）、§6（质量门禁）；#22（XState 驱动决策，与本设计正交，任一结论下本设计成立）。
> 实施方式：拆四票（A→B→C→D），见 §5/§6；本文档为各票的实施依据。

## 1. 目标与背景

**目标（一句话）**：把 `multi_file` 与 `vue_project` 两类生成的**真实生成能力**接入 TS Agent——multi_file 全链路（提示词/门禁/预算/测试）落地可用，vue_project 完成构建反馈环归属决策与设计稿。

**背景（3 句）**：旧 Java AI 的 `MultiFileCodeGenService`/`VueCodeGenService` 已随 T21（Issue #14）删除，Java 现存 AI 面只剩 createApp 智能推荐路由与 BuilderExecutor。TS Agent 现状是「契约面全通（codeGenType 白名单/计费 ×2×3/枚举）、生成面只有 html」——`DefaultBuildVerifier` 对非 html 恒拒（`src/generation/review/index.ts:138`），用户选 multi_file/vue_project 能建 run、能冻结积分，但生成必败退款。审查另发现**现行 html 提示词本身与落盘机制错位**（见 §4.3），票 A 为一切的前置。

**完成判据（可验证）**：multi_file 的 stream 请求在**真门禁**（非测试替身）下 `done` 终态、产物通过静态门禁清单；真实 provider 通道 html/multi_file 各一次 e2e 落盘验证；各票 AC 见 §6。

## 2. 范围界定

四票顺序依赖 A→B→C；D 依赖 B 落地后评估（C/D 可并行推进）。

### 票 A：提示词-工具调用约定对齐（前置，最高优先级）

- **In**：
  - 改写 `codegen-html-system-prompt.txt` 的输出格式段与特别注意事项段：Markdown 代码块输出 → writeFile 工具调用约定（§4.3）；
  - 从 `paimeng-ai-code-rag/app/prompts/codegen-multi-file-system-prompt.txt` 回迁改写为 `src/generation/prompts/codegen-multi-file-system-prompt.txt`（工具调用约定 + 多页扩展，§4.3）；
  - `PROMPT_NAMES` 增 `codegenMultiFile` 键（`src/generation/prompts/index.ts`）；
  - 真实 provider e2e 验证 html 落盘（人工验收，同 #13 口径）。
- **Out**：不动 multi_file 门禁（仍恒拒，票 B 的事）；不动 vue_project 提示词（票 D）；不动预算；不动前端；不动 Java。
- **前置依赖**：无（`.env` 配置真实 key 即可验证，`src/llm/real.ts` 四档已接入）。

### 票 B：multi_file 生成面接线（StackProfile 接缝）

- **In**：新建 `src/generation/stackProfile.ts`（契约见 §4.1）；`MultiFileBuildVerifier` + `MultiFileVisualDiffVerifier` 新增于 `src/generation/review/index.ts`；`buildDefaultReviewGates` 签名扩展（§4.2）；workflow 消费 profile（prompt/上限/门禁/machine input）；`MAX_QUALITY_ATTEMPTS` 参数化（machine input 注入，默认 3，零行为变更）；golden multi_file 换真门禁 + `MULTI_FILE_CONTENTS` 联动补引用（§7.2）；新门禁与 profile 单测。
- **Out**：前端不改（iframe 静态 serve 多文件相对链接是否可用 → 手动走查项，不开发）；Java 零改动（计费 ×2 与 BuilderExecutor NONE 直通已就绪）；vue_project 不动（仍恒拒）；预算数值不调（全 ×1 基线，票 C）。
- **前置依赖**：票 A（提示词就位）。

### 票 C：per-type 预算（budgetScale × intensity 正交组合）

- **In**：组合规则实现（§4.5）+ 三类型初始值 + 上限保护 + 组合单测。
- **Out**：不动机器拓扑；不动价格（计费权威在 Java `agent.credit.*-multiplier`）；不动 qualityAttempts 语义（绝对值已在票 B 落位）。
- **前置依赖**：票 B（StackProfile 落位）。

### 票 D：vue_project（设计先行，不实施）

- **In**：构建反馈环归属决策（§4.6 两案对比）→ 设计稿过 agent-design-review；依赖安装安全面评估。
- **Out**：本设计不实施 vue_project 生成；不引入 Node 工具链/依赖安装沙箱/dist 预览链路。
- **前置依赖**：票 B 落地后。

### 全局 Out（四票共同不动）

不 fork 三台状态机；不动 SSE 七类事件契约；不动计费协议/退款粒度；不动访谈与线框闸门（三类全保留——线框是布局契约，与栈无关）；不动图片工具与历史滑窗机制；不动 #22 相关的机器驱动方式。

## 3. 现状与约束

### 新建/修改文件清单（确切路径）

| 动作 | 路径 | 票 |
|---|---|---|
| 修改 | `paimeng-ai-code-agent/src/generation/prompts/codegen-html-system-prompt.txt` | A |
| 新建（回迁改写） | `paimeng-ai-code-agent/src/generation/prompts/codegen-multi-file-system-prompt.txt` | A |
| 修改 | `paimeng-ai-code-agent/src/generation/prompts/index.ts`（PROMPT_NAMES + PromptName） | A |
| 新建 | `paimeng-ai-code-agent/src/generation/stackProfile.ts` | B |
| 修改 | `paimeng-ai-code-agent/src/generation/review/index.ts`（+2 门禁类 + buildDefaultReviewGates 签名） | B |
| 修改 | `paimeng-ai-code-agent/src/generation/workflow/index.ts`（profile 消费） | B/C |
| 修改 | `paimeng-ai-code-agent/src/generation/workflow/machine.ts`（qualityAttempts 上限入 input，拓扑不动） | B |
| 修改 | `paimeng-ai-code-agent/src/llm/index.ts`（MULTI_FILE_CONTENTS 补 `<link>`/`<script>` 引用） | B |
| 修改 | `paimeng-ai-code-agent/test/golden-e2e.test.ts` + `test/fixtures/golden_multi_file.json` | B |
| 修改 | `paimeng-ai-code-agent/test/generation/review/review.test.ts`（+新门禁用例） | B |
| 新建 | `paimeng-ai-code-agent/test/generation/stackProfile.test.ts` | B/C |

### 硬约束

- 注释遵循 `project-comment-style`；Agent 提交 message 带 `[DSH Web/ZDAN]`。
- 测试分包与被测代码路径对称（`stackProfile.test.ts` 镜像 `src/generation/stackProfile.ts`）。
- **不能动**：machine.ts 拓扑与事件集（只扩 input 字段）；SSE 事件契约（`docs/ts_agent/contract.md`）；Java 侧任何文件；`.env` 不提交（仓库只留 `*.example`）。
- 真实通道验收需 `.env` 配置（ZHIPU_API_KEY / DASHSCOPE_CODING_API_KEY，判定函数 `src/llm/real.ts:isRealLlmConfigured`）——属人工验收项。

## 4. 技术方案

### 4.1 StackProfile 完整契约

```ts
// src/generation/stackProfile.ts（新建）
import type { PromptName } from './prompts/index.js'
import type { BuildVerifier, VisualDiffVerifier } from './review/index.js'
import type { CodeGenType } from './review/types.js'

// 预算缩放系数（票 C 落地组合规则；票 B 先落类型分派，数值全 1 = 现状基线）
export interface BudgetScale {
  /** 工具循环步数乘数：maxTurns = tier.limits.maxTurns × turns */
  turns: number
  /** 输出 token 乘数：maxOutputTokens = tier.limits.maxOutputTokens × outputTokens */
  outputTokens: number
  /** 工具调用数乘数：maxToolCalls = tier.limits.maxToolCalls × toolCalls */
  toolCalls: number
}

export interface StackProfile {
  key: CodeGenType
  /** coder 工位 system 提示词（消费点 workflow/index.ts:303 改为此查表） */
  promptName: PromptName
  /** build 门禁执行器（html 沿用现役 DefaultBuildVerifier） */
  buildGate: BuildVerifier
  /** 视觉 diff 门禁执行器（vue_project = 结构校验门禁，语义见 4.4） */
  visualDiffGate: VisualDiffVerifier
  /** 预算缩放（乘法组合规则见 4.5） */
  budgetScale: BudgetScale
  /** 质检重试上限（绝对值；经 machine input 注入，默认 3 = 现状 MAX_QUALITY_ATTEMPTS） */
  qualityAttempts: number
}

// undefined → html 基线（与请求体缺省回退 html 的既有行为一致）
export function resolveStackProfile(codeGenType: CodeGenType | undefined): StackProfile
```

### 4.2 门禁按类型分派

`buildDefaultReviewGates(provider)` → `buildDefaultReviewGates(provider, profile)`（`review/index.ts:218`）：quality 共享装配，build/visualDiff 取自 profile。`ReviewGateSet` 接口不变。

| 门禁 | html（现状不动） | multi_file（新增） | vue_project（票 D 定稿） |
|---|---|---|---|
| quality | `QualityScoreGate`（类型无关，共享） | 同左 | 同左 |
| build | `DefaultBuildVerifier`：index.html 存在 + `<html>` 根 | `MultiFileBuildVerifier`，清单：① `index.html` 存在且含 `<html>` 根；② `index.html` 内相对路径引用（`<link href>`/`<script src>`）指向的文件存在（http(s) 绝对 URL 跳过）；③ 工作区文件数 ≥ 3（与提示词三件分离约定对齐） | `VueStructureBuildVerifier`：package.json + vite 配置 + 入口 SFC 存在；npm build 归属随 4.6 决策 |
| visualDiff | `DefaultVisualDiffVerifier`：单文件锚点（`review/index.ts:195` 硬编码 index.html） | `MultiFileVisualDiffVerifier`：扫描工作区全部 `*.html` 提取 page-N 锚点**取并集**，与线框基准比对（修单文件假设；锚点约定由提示词写入——每页根节点携带 `id="page-N"`） | 结构校验门禁替代（渲染级 diff 远期，架构 §6） |

### 4.3 提示词工具调用约定（票 A 核心）

**现状错位（审查发现，票 A 的存在理由）**：现役 `codegen-html-system-prompt.txt` 第 9/10 条明确指示 Markdown 代码块输出（「最终输出必须包含 HTML 代码块」「不能输出超过 1 个代码块，否则会导致保存错误」——旧 parse-and-save 链遗物，#16 已删 `parsing.ts`）；但 TS 工作流**唯一落盘路径是 writeFile 工具调用**——`pageContent` 只进回调与收尾 system（`workflow/index.ts:290/336/434`），从不写盘。真实模型若遵循提示词 → 零工具调用 → 零文件 → build 门禁「缺少入口文件」→ 重试耗尽 failed。**假 LLM 测试矩阵直接发 tool-call 不读提示词，系统性掩盖此问题**；真实通道未做过落盘 e2e。

**改写（html，第 9/10 条替换 + 特别注意事项段同步）**：

```
9. 输出方式: 通过调用 writeFile 工具将完整代码写入 index.html。不要在回复正文中
   输出整段代码块；正文中只做简要说明。
10. 修改请求: 收到修改要求时，调用 writeFile 重写完整文件（不要只输出差异片段）。
```

**改写（multi-file 回迁）**：保留留档件的技术栈/三件分离/禁止外部依赖/响应式/占位符约束，替换输出方式段为 writeFile 约定；**单页三件约定扩展为多页**（与线框闸门的 5 页上限、站点地图约束对齐）：`index.html` + `style.css` + `script.js` 三件分离为下限，多页站每页独立 `页名.html` 经相对链接互跳、共享 style.css/script.js，每页根节点携带 `id="page-N"`（视觉 diff 锚点，见 4.2）。

### 4.4 vue_project 的 visualDiffGate 语义

「deferred」的准确语义 = **该类型不跑线框视觉 diff**：`StackProfile.visualDiffGate` 装配结构校验门禁（SFC 存在性/命名规范），渲染级 diff 属远期验收管线（架构 §6）。票 D 定稿具体校验清单。

### 4.5 预算组合规则（票 C）

```
最终上限 = tier.limits.X × profile.budgetScale.X（四舍五入取整）
```

- 初始值：html `{1,1,1}`（现状）；multi_file `{2,2,2}`；vue_project `{4,3,3}`（票 C 用真实通道调参，数值属票 C 验收范围）。
- 上限保护：组合后 `maxOutputTokens` ≤ 32000（模型上下文硬上限，防配置事故）。
- `qualityAttempts` 为绝对值（重试次数无乘法语义）：html/multi_file 3（现状）、vue_project 5（票 D 定）。

### 4.6 构建反馈环归属（票 D 决策项）

- **方案 B（已选，受控反馈环）**：Java `BuilderExecutor` 作为 `vue_project` 唯一权威构建执行器；TS Agent 只做不执行代码的结构预检，通过 Java 内部回调接收结构化构建结果，失败时回灌 coder 并执行有界修复轮。Agent 零 npm 工具链和依赖安装沙箱；代价是一次内部回调往返，且需冻结回调幂等、超时、隔离和诊断过滤契约。
- 方案 A（Agent 侧 npm build）仅在后续证明回调延迟或吞吐成为实际瓶颈时重新评估；不在本票实施。
- 详细决策、请求/响应字段、威胁模型、超时与缓存约束见 `docs/ts_agent/vue-project-build-feedback-design.md`。

### 4.7 数据流（票 B 后）

```
POST /agent/stream (codeGenType=multi_file)
  → 预检（run phase / 余额 / 线框闸门 / 冻结 ×2 —— 全部不变）
  → resolveStackProfile('multi_file')
  → coding: system = loadPrompt(profile.promptName) + 档位说明 + 历史滑窗 + 质检意见回喂
           上限 = tier.limits × profile.budgetScale
  → review: buildDefaultReviewGates(provider, profile)
           = QualityScoreGate + MultiFileBuildVerifier + MultiFileVisualDiffVerifier
  → 重试 guard: profile.qualityAttempts（machine input 注入，默认 3）
  → done → 回调 Java /complete → BuilderExecutor(NONE 直通) —— Java 零改动
```

### 4.8 取舍记录

- **不 fork 三台状态机**：拓扑/里程碑/退款粒度/SSE 契约会翻倍，纯付协调税。
- **策略对象而非 if-else 散布**：类型差异收敛单点；html/multi_file 两个 adapter 成真实接缝后，vue_project 只是第三行注册。
- **线框闸门三类保留**：线框是布局契约不是产物预览，与栈无关。
- **machine 只扩 input 不动拓扑**：与 #22（驱动 vs 簿记）正交，任一结论下本设计成立。

## 5. 任务分解

### 票 A（提示词约定对齐）

| # | 任务 | 产出物 | 验证 |
|---|---|---|---|
| A1 | 改写 html 提示词（输出格式段 + 特别注意事项段） | `prompts/codegen-html-system-prompt.txt` | §6 票 A AC3 + A4 |
| A2 | 回迁改写 multi-file 提示词 + `PROMPT_NAMES` 扩键 | `prompts/codegen-multi-file-system-prompt.txt` + `prompts/index.ts` | `npm test` 全绿 |
| A3 | 回归确认（假 LLM 剧本不受提示词变化影响） | 无新文件 | `npm test` 160/160 |
| A4 | 真实 provider e2e（html 落盘） | progress.md 验收记录 | curl 全链 → 工作区落盘 + done |

依赖：A1、A2 可并行；A4 依赖 A1 + `.env` 真实 key。

### 票 B（multi_file 接线）

| # | 任务 | 产出物 | 验证 |
|---|---|---|---|
| B1 | StackProfile 模块 + 单测 | `src/generation/stackProfile.ts` + `test/generation/stackProfile.test.ts` | 单测 |
| B2 | `MultiFileBuildVerifier`（清单 ①②③）+ 用例 | `review/index.ts` + `review.test.ts` 追加 | 单测（含边界 §6 票 B ①②③） |
| B3 | `MultiFileVisualDiffVerifier`（锚点并集）+ 用例 | 同上 | 单测（含边界 ④） |
| B4 | `buildDefaultReviewGates` 签名 + workflow 消费 profile | `review/index.ts` + `workflow/index.ts` | 全量回归 |
| B5 | machine `qualityAttempts` 入 input（默认 3）+ 用例 | `machine.ts` + machine 用例 | 单测（默认行为零变更，边界 ⑤） |
| B6 | `MULTI_FILE_CONTENTS` 补 `<link href="style.css">` / `<script src="script.js">` | `llm/index.ts:211-224` | golden e2e |
| B7 | golden multi_file 换真门禁 | `golden-e2e.test.ts` + fixture | e2e done 终态 |

依赖：B1 → B4 → B7；B2/B3/B5/B6 可并行；票 A 前置。

### 票 C（预算）

| # | 任务 | 产出物 | 验证 |
|---|---|---|---|
| C1 | 组合规则 + 上限保护 | `stackProfile.ts` + 单测 | `2×2=4`、>32000 截断、×1 恒等 |
| C2 | 三类型初始值 | `stackProfile.ts` | 单测 |
| C3 | fast × vue_project 边界组合 | 单测 | fast.maxTurns=1 × 4 = 4 不越界 |

依赖：票 B。

### 票 D（vue 设计稿）

| # | 任务 | 产出物 | 验证 |
|---|---|---|---|
| D1 | 反馈环两案对比设计 | 设计稿（`docs/ts_agent/`） | agent-design-review |
| D2 | 依赖安装安全面评估 | 并入 D1 | 同上 |

依赖：票 B 落地后评估。

## 6. 验收标准

### 票 A

- [ ] `cd paimeng-ai-code-agent && npm test` 全绿（≥160）
- [ ] `npm run type-check` 0 错
- [ ] `grep -c '代码块' src/generation/prompts/codegen-html-system-prompt.txt` = 0（输出约定彻底工具化）
- [ ] `PROMPT_NAMES.codegenMultiFile` 可 load（`loadPrompt` 用例）
- [ ] 真实 provider e2e（人工，progress.md 留证）：配置真实 key 后 curl `POST /agent/stream`（codeGenType=html）→ SSE done 终态 + 工作区 `index.html` 含 `<html>` 根

### 票 B

- [ ] `npm test` 全绿；新增用例 ≥ 8
- [ ] golden multi_file：**真门禁**下 done 终态、error 事件 0、三文件含夹具片段、`index.html` 含 `<link href="style.css">`
- [ ] multi_file stream e2e（fake LLM）：白名单放行 + 真门禁通过 + 冻结系数 ×2 不变
- [ ] html 行为零变更：现役用例无回归（profile 默认基线 = 现状数值）
- [ ] 边界用例：① `index.html` 引用不存在文件 → build 门禁失败；② 工作区仅 2 文件 → 失败；③ `https://` 外链跳过不校验；④ page-N 锚点分散两个 HTML → 并集通过；⑤ machine input 缺省时 qualityAttempts=3（零行为变更）
- [ ] 前端手动走查（人工，同 #13 口径）：iframe 预览 multi_file 产物，相对链接/样式/脚本生效

### 票 C

- [ ] 组合规则单测：乘法、上限保护（>32000 截断）、×1 恒等三例
- [ ] fast × vue_project 组合：`1×4=4` 不越界
- [ ] `npm test` + `npm run type-check` 全绿

### 票 D

- [ ] 设计稿过 agent-design-review（PASS 或整改后 PASS-WITH-FIXES）
- [ ] 反馈环归属有明确结论 + 依据（含安全面评估）

## 7. 风险与陷阱

1. **提示词-工具错位是现行带病状态**（票 A 的存在理由，§4.3）：假 LLM 直接发 tool-call 不读提示词，测试全绿掩盖问题；改写后必须真实通道验证（A4），不能只靠假 LLM。
2. **golden 剧本联动**：B2 门禁校验引用存在性 ↔ `MULTI_FILE_CONTENTS` 的 `index.html`（`llm/index.ts:211-224`）必须补 `<link href="style.css">`/`<script src="script.js">`——门禁与剧本不同步改必挂（该剧本现内容不含任何引用）。
3. **超限收尾跳过门禁**：`truncatedByLimit` 分支直接 PASS done 不跑门禁（`workflow/index.ts:396`）——budgetScale 放大上限后此路径的产物完整性风险仍存（收尾调用不带工具、不落盘）。票 C 调参时评估是否对 multi_file 收紧（如收尾后仍跑 build 门禁）；本设计不扩范围，留档待定。
4. zhipu 通道 `responseFormat is not supported` 警告（#19 在档）不影响工具调用（tools 是独立参数），已知无动作。
5. `PROMPT_NAMES` 扩键后 `PROMPTS_DIR` 运行时解析（esbuild 产物不内联 .txt）需在真实通道复跑（A4 覆盖）。

## 8. 参考资料

- **架构依据**：`docs/ts_agent/architecture.md` §5（生成物运行时阶梯 L0-L3）、§6（质量门禁/三工位）、技术栈强制选择条目。
- **现状实现**：`paimeng-ai-code-agent/src/generation/workflow/index.ts`（coder/reviewer 工位、超限收尾 396、pageContent 290/336/434）、`src/generation/workflow/machine.ts`（拓扑/guard/MAX_QUALITY_ATTEMPTS）、`src/generation/review/index.ts`（三门禁：DefaultBuildVerifier 135、DefaultVisualDiffVerifier 183 单文件读 195、buildDefaultReviewGates 218）、`src/generation/prompts/index.ts`（PROMPT_NAMES/loadPrompt）、`src/generation/review/types.ts`（CodeGenType）。
- **提示词留档**：`paimeng-ai-code-rag/app/prompts/`（7 份原件，multi-file/vue-project 待回迁源）。
- **测试基建**：`paimeng-ai-code-agent/test/helpers.ts`（`makePassingReviewGates` 替身——票 B 换真门禁的对象）、`test/fixtures/golden_multi_file.json`、`src/llm/index.ts:211-224`（MULTI_FILE_CONTENTS）。
- **契约与遗留**：`docs/ts_agent/contract.md`（SSE 七类事件）、`docs/ts_agent/contract-parity.md`（P3 修正项清单）。
- **Java 侧（零改动确认）**：`src/main/java/com/zdan/paimengaicodemother/core/builder/BuilderExecutor.java`（NONE 直通/NPM 构建）、`ai/enums/CodeGenTypeEnum.java`。
- **真实通道**：`paimeng-ai-code-agent/src/llm/real.ts`（四档 provider、`isRealLlmConfigured:25`）。
