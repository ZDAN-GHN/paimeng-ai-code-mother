# Supplement to DSH SOP

## DSH 沙箱调用规则

- 首次调用绝不带 `sandbox_permissions`。
- 失败先归类再动：参数错（`Error: invalid ...`）改参重发；命令错（`[exit code: N]`）修命令；沙箱拒（`[sandbox: ... denied ...]`）才升权；禁止盲目重试。
- 升权＝同一轮次重试**原命令一次**：选最窄够用模式，`justification` 为一句具体的非空说明；审批框即许可，勿在对话里先问。
- 升权被拒＝该命令终局：停止并说明，禁止改命令/换路径/sudo/写别处绕过。
- 会话声明审批不可用：永不设置 `sandbox_permissions`。

## DSH Subagent 规则

- 委派 `subagent` 必须成对显式指定 `provider` + `model`，取值以 `list_subagent_models` 目录为准；不确定就先调用它查询。
- `reasoning_effort` 一律省略：本部署无广告值，省略即用所选模型默认。
- `subagent_fork` 无模型字段、继承父路由，不得为其指定或要求更换模型。