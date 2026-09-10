# Triage labels：GitHub

`/to-spec`、`/to-tickets`、`/triage` 等工程技能用到的规范角色 → 本仓库实际标签名的映射。
标签操作见 [issue-tracker.md](issue-tracker.md)。

| 规范角色 | 本仓库实际标签 | 状态 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 尚未创建（首次需要时 `gh label create`） |
| `needs-info` | `needs-info` | 尚未创建（首次需要时 `gh label create`） |
| `ready-for-agent` | `ready-for-agent` | 已存在：Spec ready for an implementation agent to pick up |
| `ready-for-human` | `ready-for-human` | 尚未创建（首次需要时 `gh label create`） |
| `wontfix` | `wontfix` | 已存在（GitHub 默认：This will not be worked on） |

约定：

- `/to-tickets` 产出的票默认贴 `ready-for-agent`。
- 「尚未创建」行是**记录事实**而非待办：本仓库目前只有 `ready-for-agent` 与 `wontfix` 两条在用，规范角色名即标签名，无需另建同义标签。
