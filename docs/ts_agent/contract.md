# TS Agent 浏览器 SSE 契约

状态：Issue #5 定稿。该协议由浏览器通过 `fetch` 直连 TS Agent，Java 不中转生成流。

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
