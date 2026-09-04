# TS Agent 浏览器 SSE 契约

状态：Issue #5 定稿；Issue #7 增补需求工程（访谈/线框/确认）与 codegen 闸门。该协议由浏览器通过 `fetch` 直连 TS Agent，Java 不中转生成流。

## 需求工程与 codegen 闸门（Issue #7）

需求收敛前半程由三个 JSON 请求/响应端点完成（均 JWT 鉴权），run 状态经 Java 内部 API 持久化（`generation_run`，跨请求存活）；codegen（`/agent/stream`）受线框闸门约束。

| 端点 | 请求 | 响应要点 | 阶段变更 |
|---|---|---|---|
| `POST /agent/interview` | `{ runId, appId, message?, answers? }` | `{ round, complete, questions? / summary }` | 建 run（interview）；访谈状态入 context |
| `POST /agent/wireframe` | `{ runId, appId, workspacePath }` | `{ phase, wireframe: { relativeUrl, pageCount } }` | → `wireframe_pending`；免费 + 每日限频（超限 429） |
| `POST /agent/wireframe/confirm` | `{ runId, appId }` | `{ phase, wireframe }` | → `wireframe_confirmed`（积分冻结时刻，见 #10） |
| `POST /agent/stream` | 见下 | SSE | 闸门：仅 `wireframe_confirmed` 放行 |

- **访谈**：固定 5 维（受众/风格/页面清单/数据需求/交互），每维 2-4 选项选择题，**最多 2 轮**；各维均已作答即收束（跳过剩余轮次），`complete: true` + `summary` 喂线框。答案经 `answers: [{ key, optionId, text? }]` 提交，跨请求续答。
- **线框**：快速档模型产出单文件 HTML（灰块 + 占位图 + 页内锚点可点击跳转 + 站点地图），存 `{workspace}/wireframe/wireframe.html`，**页面数 ≤ 5**；免费但每用户每日独立限频（Java 内部配额端点，超出 → HTTP 429）。
- **闸门（核心）**：未确认线框的 codegen 请求被拒——`/agent/stream` 先经 Java 内部 API 校验 run 阶段，非 `wireframe_confirmed` 时输出唯一 `error` 事件（明确报错），不发任何业务事件。已确认线框即 codegen 布局契约与视觉 diff 基准。**闸门状态存于 Java `generation_run`，未配置 Java 内部 API 时 codegen 拒绝放行**（`error` 事件「Java 内部 API 未配置，无法校验线框闸门」），与需求工程端点的 503 口径一致，避免绕过闸门。
- **重新访谈 = 需求变更**：`wireframe_pending` 阶段重新访谈会使 run 回到 `interview` 并**失效既有未确认线框**（旧线框不能再被确认，须重新生成），防止锁定与新需求不一致的布局契约。

## 请求

`POST /agent/stream`，请求头为 `Authorization: Bearer <JWT>` 和 `Content-Type: application/json`。

```json
{
  "runId": "run-123",
  "appId": "1001",
  "message": "生成一个个人主页",
  "workspacePath": "/repo/tmp/code_output/html_1001",
  "script": "success"
}
```

`runId`、`appId`、`message` 必填。`userId` 可由请求提供；生产请求通常从 JWT 的 `sub` 获取。`script` 仅用于离线验收，值为 `success`（默认）或 `error`。

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

`interview → coding → review → done`

失败时更新为 `failed`，然后发送 `error`。run 更新经 Java 内部 API 完成，使用 Bearer 服务令牌和 `runId` 幂等；TS Agent 不直连 MySQL。

## 终态与错误

成功响应不得在 `done` 后继续产生事件。失败响应不得发送 `done`，`error` 后不得产生业务事件。工作区路径必须位于配置的 `WORKSPACE_ROOT` 内，否则返回错误终态并且不得写文件。
