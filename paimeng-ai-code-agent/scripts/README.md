# 脚本规则

`scripts/` 只保留仍会被日常开发、部署、诊断或验证复用的入口。脚本不是历史档案；一次性脚本执行完成后，结果记录在被归档的计划、提交信息或运行证据里，脚本本身从工作区删除。

## 规则

1. **只留可复用入口。** 新增脚本必须由 `package.json`、CI、测试或当前文档引用；没有调用方的脚本不应长期留在这里。
2. **一次性脚本用完即删。** 迁移、回填、历史对照、数据修复等脚本执行并验证后，删除脚本文件、对应的 `package.json` 命令和当前文档中的命令引用。不要把脚本移入 `archive/`，也不要靠注释标记“以后可能还会用”。
3. **仍在等待执行的一次性脚本要显式列出。** 只有对应的计划仍未完成时才保留；计划完成或生产切换完成后，按上一条删除。当前只有 legacy 导入两项属于这种例外。
4. **按用途分包。** 入口放在 `dev/`、`db/`、`verify/`、`ops/`；共享实现放 `lib/`，Git hooks 放 `hooks/`。不复制共享逻辑。
5. **命令默认安全。** 迁移/回填类必须默认预演，只有显式 `--apply` 才写数据；脚本自己校验目标数据库，不能靠调用者记得加保护。

## 目录

| 目录 | 内容 |
| --- | --- |
| `dev/` | `durable-dev`、`dev-stop`、`preview`：本地开发进程与预览服务。 |
| `db/` | 迁移、测试库、模型初始化、管理员操作，以及待执行的 legacy 导入。 |
| `verify/` | 静态检查、边界检查、基础设施/重启验收和隔离 E2E 启动器。 |
| `ops/` | 基础设施启动、数据库建库和 harness 诊断。 |
| `hooks/` | 可选安装的 Git hooks；归档目录不在这里。 |

## 当前入口

| 类别 | 入口 |
| --- | --- |
| 开发与进程 | `npm run dev`、`npm run dev:stop`、`npm run preview`、`npm run durable:pg`、`npm run infra:up` |
| 数据库 | `npm run db:migrate`、`npm run db:test:setup`、`npm run db:admin`、`npm run db:init-models` |
| 验证与质量 | `npm run check:ui`、`npm run check:e2e`、`npm run verify:boundary`、`npm run verify:infra`、`npm run verify:restart`、`npm run test:e2e:isolated` |
| 诊断 | `npm run durable:inspect` |

## 待执行的一次性脚本

以下脚本属于尚未完成的生产切换流程，暂留到 `docs/plans/legacy-import.md` 完成后删除：

| 命令 | 用途 |
| --- | --- |
| `npm run db:import -- <snapshot>` | 导入已审查的 JSON 用户/应用副本，可选复制旧产物。 |
| `npm run legacy:import -- --runtime <副本>` | 把旧预览和未发布草稿导入新的交付/草稿控制面。 |

## 已清理

品牌图片导入与旧 UI 对照脚本已执行并从 `scripts/` 删除；版本回填/迁移入口随版本计划归档而清理。需要复现当时操作时，查看对应的归档计划和 Git 历史，不要恢复这些脚本作为日常入口。
