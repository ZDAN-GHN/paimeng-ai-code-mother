# 脚本入口

开发、迁移和测试的日常入口见[项目 README](../README.md)。以下三项保留供手动迁移或历史对照使用，不属于启动步骤、日常测试或 CI 门禁。

| 命令 | 用途与前提 |
| --- | --- |
| `npm run assets:import` | 一次性从归档 Vue 平台复制品牌图片。`public/paimeng.png` 已纳入仓库，只有需要重新取原图时才运行。旧文件只读。 |
| `npm run db:import -- <snapshot>` | 一次性导入审查过的 JSON 用户/应用副本，可选复制旧产物。先备份并停止目标平台写入，源文件只读；拒绝覆盖已有记录或产物。雪花导入回归仍验证这一契约。 |
| `npm run verify:parity` | 一次性旧 UI 对照与截图。依赖归档平台的历史构建和约定端口，不证明当前生成链路；当前界面回归使用隔离 E2E。 |

MySQL → Postgres 的业务行迁移已经完成。`db:import-mysql` 与其导入脚本已退役，因此产品不再依赖 MySQL 驱动。需要研究当时的迁移时，查阅[历史记录](../docs/plans/archive/pi-durable-m4.md)和 Git 历史（脚本最后保留于 `ef91aa8`）；旧容器和数据继续保留归档。
