# TS Agent 浏览器 SSE 契约

状态：Issue #5 定稿；Issue #7 增补需求工程（访谈/线框/确认）与 codegen 闸门；Issue #9 增补三工位质检循环、护栏、三档强度与 token 计量；Issue #10 增补积分冻结/结算/退款与对话中断（aborted 终态）。该协议由浏览器通过 `fetch` 直连 TS Agent，Java 不中转生成流。

## 需求工程与 codegen 闸门（Issue #7）

需求收敛前半程由三个 JSON 请求/响应端点完成（均 JWT 鉴权），run 状态经 Java 内部 API 持久化（`generation_run`，跨请求存活）；codegen（`/agent/stream`）受线框闸门约束。

| 端点 | 请求 | 响应要点 | 阶段变更 |
|---|---|---|---|
| `POST /agent/interview` | `{ runId, appId, message?, answers? }` | `{ round, complete, questions? / summary }` | 建 run（interview）；访谈状态入 context |
| `POST /agent/wireframe` | `{ runId, appId, workspacePath }` | `{ phase, wireframe: { relativeUrl, pageCount } }` | → `wireframe_pending`；免费 + 每日限频（超限 429） |
| `POST /agent/wireframe/confirm` | `{ runId, appId }` | `{ phase, wireframe }` | → `wireframe_confirmed`（积分冻结时刻，见 #10） |
| `POST /agent/stream` | 见下 | SSE | 闸门：仅 `wireframe_confirmed` 放行；进入 codegen 前**冻结积分**（见 #10） |

- **访谈**：固定 5 维（受众/风格/页面清单/数据需求/交互），每维 2-4 选项选择题，**最多 2 轮**；各维均已作答即收束（跳过剩余轮次），`complete: true` + `summary` 喂线框。答案经 `answers: [{ key, optionId, text? }]` 提交，跨请求续答。
- **线框**：快速档模型产出单文件 HTML（灰块 + 占位图 + 页内锚点可点击跳转 + 站点地图），存 `{workspace}/wireframe/wireframe.html`，**页面数 ≤ 5**；免费但每用户每日独立限频（Java 内部配额端点，超出 → HTTP 429）。
- **闸门（核心）**：未确认线框的 codegen 请求被拒——`/agent/stream` 先经 Java 内部 API 校验 run 阶段，非 `wireframe_confirmed` 时输出唯一 `error` 事件（明确报错），不发任何业务事件。已确认线框即 codegen 布局契约与视觉 diff 基准。**闸门状态存于 Java `generation_run`，未配置 Java 内部 API 时 codegen 拒绝放行**（`error` 事件「Java 内部 API 未配置，无法校验线框闸门」），与需求工程端点的 503 口径一致，避免绕过闸门。
- **重新访谈 = 需求变更**：`wireframe_pending` 阶段重新访谈会使 run 回到 `interview` 并**失效既有未确认线框**（旧线框不能再被确认，须重新生成），防止锁定与新需求不一致的布局契约。
- **积分冻结（Issue #10，架构 §7 扣费协议）**：`/agent/stream` 通过线框闸门后、进入 codegen 前，TS Agent 调 Java 内部 `POST /internal/agent/runs/{runId}/credit/freeze`（请求体 `{ intensity }`）预扣积分——冻结额 = 基础价 × 生成类型系数 × 强度档位系数。**余额不足 → HTTP 402**，TS Agent 输出唯一 `error` 事件（明确报错），**不进入 codegen**（不产生任何 token 消耗）；其他冻结失败同样拒绝放行。冻结幂等（同 runId 重复冻结返回既有台账，不重复扣款）。

## 请求

`POST /agent/stream`，请求头为 `Authorization: Bearer <JWT>` 和 `Content-Type: application/json`。

```json
{
  "runId": "run-123",
  "appId": "1001",
  "message": "生成一个个人主页",
  "workspacePath": "/repo/tmp/code_output/html_1001",
  "script": "success",
  "intensity": "standard",
  "history": [
    { "role": "user", "content": "做一个宠物店网站" },
    { "role": "assistant", "content": "好的，请补充想要的风格。" }
  ],
  "codeGenType": "html"
}
```

`runId`、`appId`、`message` 必填。`userId` 可由请求提供；生产请求通常从 JWT 的 `sub` 获取。`script` 仅用于离线验收，值为 `success`（默认）、`error`、`images`、`limit` 或质检剧本（`quality-fail-then-pass` / `quality-fail-always`）。

**Issue #9 新增字段（均可选，缺省有默认）**：

- `intensity`：三档推理强度，`fast` / `standard`（默认）/ `deep`。决定模型路由（对应模型 id）、护栏上限（`max_turns` / `max_output_tokens` / `max_tool_calls` / `max_images` 随档位放大）与价格系数（fast = 0.5 / standard = 1 / deep = 2，2026-09-08 定价；冻结额 = 基础价 100 × 生成类型系数 × 档位系数，计费权威在 Java `agent.credit.*-multiplier`）。
- `history`：输入历史滑窗输入，`[{ role: 'user'|'assistant', content }]`。Agent 侧保留**最近 10 轮全文**，更早轮次折叠为摘要并入 system（架构 §3.3 输入侧有界）。
- `codeGenType`：生成类型（`html` 默认 / `multi_file` / `vue_project`），build 门禁按类型分派。

响应 `Content-Type` 为 `text/event-stream; charset=utf-8`。每帧以空行分隔：

```text
event: <type>
data: {"type":"<type>",...}

```

JSON 数据中的换行必须是转义字符；协议解析应按事件字段语义断言，不比较完整响应字节。若数据本身需要多行，SSE 序列化器按行输出多个 `data:` 字段，消费者再按 SSE 规则重组。

## 事件

| event | 必填字段 | 语义 |
|---|---|---|
| `ai_thinking` | `type`, `text` | 模型思考过程的增量文本；不保证连续块边界 |
| `ai_response` | `type`, `data` | 模型面向用户或生成物的增量文本；按出现顺序拼接 |
| `tool_request` | `type`, `id`, `name`, `arguments` | 请求执行工具；`arguments` 是 JSON 字符串 |
| `tool_executed` | `type`, `id`, `name`, `arguments`, `result` | 工具执行完成；同一 `id` 必须先有 `tool_request` |
| `milestone` | `type`, `title`, `detail`（可选） | 工作流节点跳变的人话里程碑；可用于进度展示 |
| `done` | `type` | 唯一成功终态，必须是最后一个事件 |
| `error` | `type`, `message` | 唯一失败终态；发出后不得再有任何业务事件 |

`type` 必须与 SSE `event` 名一致。事件可以在非终态阶段穿插，但成功脚本至少满足：`milestone(interview)`、`ai_thinking`、`milestone(coding)`、`tool_request`、对应的 `tool_executed`、`milestone(review)`、`milestone(done)`、`done`。

## 生命周期

Agent 创建 run 时使用 `interview`。工作流节点推进时更新同一 `runId`：

`interview → coding → review → done`（**Issue #9：review 质检失败且有界重试余量时回 coding 重试**，拓扑见图，最多 2 次重试 = 共 3 次尝试）

失败时更新为 `failed`，然后发送 `error`。run 更新经 Java 内部 API 完成，使用 Bearer 服务令牌和 `runId` 幂等；TS Agent 不直连 MySQL。

**Issue #10 对话中断（架构 §3.5 中止 (a)）**：客户端断开（关页面/中止按钮 abort）时，TS Agent 感知连接关闭 → **取消 LLM 调用** → **保留已写文件**（半成品可继续补完）→ run 推进 `aborted` 终态 → 回调 Java（`status=aborted` + `filesWritten` 已落盘文件数）。Java 侧写历史带 `[用户中断]` 标记并按里程碑折算退款：**首个文件落盘前（filesWritten=0）全额退款**，已写文件则部分结算（进入 review 的里程碑按高比例结算，其余按基础比例）。`aborted` 是终态，其后不再发业务事件（`error` 事件提示「生成已中断」）。

**Issue #9 里程碑增补**（重试路径，`milestone` 事件 title）：

| title | 语义 |
|---|---|
| `根据质检意见重新生成` | review 失败回 coding 重试（进入 coding） |
| `复查生成结果` | 重试后的 review 复查 |

**Issue #9 token 计量**：run 进入终态（`done`/`failed`）前，Agent 经 `PATCH /internal/runs/{runId}` 携带 `tokenUsage` JSON 落库（`{ inputTokens, outputTokens, totalTokens }`），累计本次 run 全部模型调用（codegen 各轮 + 超限收尾调用）。

**Issue #9 硬上限与超限收尾（设计取舍明示）**：每 run 差异化硬上限（max_turns / max_output_tokens / max_tool_calls=50 先例 / 图片 4 张，随三档强度放大）。超限（工具调用被 max_tool_calls/max_turns 截断，或输出达 max_output_tokens 截断）时**注入收尾指令**让模型基于已生成内容输出完整交代，**绝不硬杀**；状态机仍按拓扑推进（coding → review → done），但 review **不再跑三重门禁**——已达成本上界，重试必然再次触发同一上限（架构 §3.3「超限 = 优雅收尾，用户拿到完整交代」）。即：**超限路径的产物未经质检即 done**，这是有意取舍（MVP 成本上界优先），Playwright 渲染级视觉 diff 属远期验收管线（架构 §6）。

## 终态与错误

成功响应不得在 `done` 后继续产生事件。失败响应不得发送 `done`，`error` 后不得产生业务事件。工作区路径必须位于配置的 `WORKSPACE_ROOT` 内，否则返回错误终态并且不得写文件。
