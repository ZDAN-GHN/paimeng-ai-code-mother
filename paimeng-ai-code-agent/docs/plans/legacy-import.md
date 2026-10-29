# legacy 预览 / 草稿导入与切换演练

本文对应 `scripts/import-legacy-state.ts`（`npm run legacy:import`）与用户、应用、产物导入（`npm run db:import`）。它只把**当前旧预览**和**未发布工作区草稿**接进新控制面，不导入旧版本历史、不重建 generation，也不删除任何旧目录。生产切换不在本文自动执行。

## 前置条件

1. 已停止平台写入：没有正在生成、部署或修改应用的操作。
2. 旧运行目录已冻结（只读备份或快照），`runtime/code_output/` 不再被旧进程改写。
3. 目标库已执行 `npm run db:migrate`，至少包含 `migrations/006_harness_control.sql` 与 `migrations/007_harness_attempt_tool.sql`。
4. 先完成用户/应用记录与旧产物搬迁（`npm run db:import -- runtime/import/snapshot.json --artifacts <旧项目根目录> ...`），再执行本导入。否则应用行或 `code_output` 可能还不存在。
5. 已备份产品库、执行库和运行目录。回退只能恢复匹配的数据库与运行目录，不能只降级代码。

## 备份

```bash
# 产品库与 harness 执行库
pg_dump "$DATABASE_URL" > backup/paimeng_app.sql
pg_dump "${DURABLE_PG_URL:-postgres://postgres:postgres@127.0.0.1:5432/paimeng_agent}" > backup/paimeng_agent.sql

# 运行目录（含 code_output / deliver 产物与将写入的 deliveries）
cp -a runtime backup/runtime-before-legacy-import
```

`MODEL_SECRET_KEY` 或 `runtime/model-secret.key` 与备份一起保管；换主密钥后旧密文无法解密。

## 导入什么，不导入什么

| 旧数据 | 新落点 | 说明 |
| --- | --- | --- |
| `runtime/code_output/<type>_<appId>`（工程类型取 `dist/`） | `deliveries/<type>_<appId>/<uuid>/` + `generation_delivery` + `app_preview_pointer` | 生成不可变交付；`generation_id` 为 `null` |
| 同一工作区源码（排除 `.git`、`node_modules`、`.next`、`dist`、`.paimeng-*`、`.env*` 等） | `runtime/snapshots/legacy/<type>_<appId>/<digest>/` + `source_snapshot(kind=draft)` | 接到 `app_authority.draft_snapshot_id`，下一轮生成从草稿继续 |
| 文件预览指针 | `runtime/previews/<type>_<appId>.json` | 数据库指针是权威，文件指针供预览服务读取 |
| 旧版本历史 | **不导入** | 旧版本允许暂缺 delivery；需要时走历史恢复的 legacy 重建 |
| 旧聊天/文本消息 | **不导入** | 新转录由 harness 维护；旧文本历史已随切 Postgres 放弃 |
| `version_record` / `generation` | **不创建** | 不伪造版本或生成行 |

legacy 标识不新增数据库列：

- `generation_delivery.generation_id is null`，`generation_delivery.version_sha` 是按 `paimeng-legacy:<type>:<appId>` 算出的确定性 40 位十六进制值，并且不存在于 `version_record`。
- 草稿目录固定在 `runtime/snapshots/legacy/`，`source_snapshot.kind = 'draft'`、`generation_id is null`、`status = 'sealed'`。
- `source_snapshot.message` 记录 `legacy 导入：旧预览` / `legacy 导入：未发布草稿`，便于人工核对。

同一应用重复执行会复用同一个 `version_sha` 和内容寻址的草稿目录；已有交付、数据库指针与文件指针的应用直接跳过。

## 预演（默认 dry-run）

```bash
npm run legacy:import -- --runtime ./runtime
# 只演练一个应用
npm run legacy:import -- --app <appId> --runtime ./runtime
```

dry-run 只读扫描 `code_output`，不写数据库、不创建 `deliveries/`、`snapshots/` 或 `previews/`。输出会逐应用打印：

- `[dry-run] 导入 ...`：将生成交付并登记草稿；
- `跳过 ...：已有预览指针` / `旧预览不存在` / `已有草稿快照` / `应用正在生成`；
- `[dry-run] 修复 ...`：数据库已有指针但文件指针缺失，apply 时只补文件指针。

发现任何 `失败` 先修正源目录再继续；不要用跳过代替失败。

## 正式执行

```bash
npm run legacy:import -- --apply --runtime ./runtime
# 单应用重试
npm run legacy:import -- --apply --app <appId> --runtime ./runtime
```

执行顺序（每个应用）：

1. 只读预检：已有指针/草稿、未收束执行、源目录是否安全、`index.html` 是否存在。
2. 把工作区复制到 `runtime/snapshots/legacy/...` 的临时目录，计算内容 SHA-256 后原子 rename。
3. 把旧预览复制到临时目录（排除平台文件），用 `createDelivery` 生成不可变交付。
4. 一个数据库事务写入：`source_snapshot`（预览与草稿）、`generation_delivery`、`app_preview_pointer`（revision 单调）、`app_authority`（state=idle、draft_snapshot_id、preview_delivery_id；不改 `owner_epoch`）。
5. 事务提交后校验并写 `runtime/previews/<type>_<appId>.json`。数据库指针是权威；文件指针写失败时命令返回非零，后续再跑会走 `修复` 分支补写。

数据库失败时不会留下本次新建的交付/草稿目录；文件复制失败时数据库事务不会开始。旧 `code_output`、旧部署目录和用户数据都不删除。

## 校验

无 `psql` 时用 Node：

```bash
node --env-file=.env --input-type=module <<'EOF'
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query(`
  select a.id,
         d.version_sha,
         d.generation_id,
         p.delivery_id,
         p.revision,
         au.draft_snapshot_id,
         au.state,
         au.owner_epoch
    from app a
    left join app_preview_pointer p on p.app_id = a.id
    left join app_authority au on au.app_id = a.id
    left join generation_delivery d on d.id = p.delivery_id
   where a.is_delete = 0
   order by a.id`);
console.table(rows);
const { rows: counts } = await client.query(`
  select
    (select count(*) from generation_delivery where generation_id is null) as legacy_deliveries,
    (select count(*) from source_snapshot where generation_id is null and kind = 'draft') as legacy_drafts,
    (select count(*) from version_record) as version_rows`);
console.table(counts);
await client.end();
EOF
```

要点：

- 有旧预览的应用，`p.delivery_id` 非空且 `d.generation_id` 为 null；
- `version_sha` 匹配 `^[0-9a-f]{40}$`，且 `select * from version_record where commit_sha = d.version_sha` 为空；
- 有工作区源码的应用，`au.draft_snapshot_id` 非空、`au.state = 'idle'`，`owner_epoch` 未被改写；
- `generation` 表没有因本次导入新增行；
- `runtime/previews/<type>_<appId>.json` 的 `deliveryId` 与数据库指针一致；
- 预览来源实际能打开：`curl -I "$PREVIEW_ORIGIN/preview/<type>_<appId>/"`。

## 重复执行与回退

- **重复执行**：已有数据库与文件指针的应用会跳过；同应用不会新增交付，`app_preview_pointer.revision` 与文件指针 revision 不推进。只缺文件指针时执行 `修复`。
- **只回退文件指针**：删除 `runtime/previews/<type>_<appId>.json` 会让预览回退到旧 `code_output`；数据库指针仍在，恢复扫描会按数据库指针补写。需要彻底回退时按下面的完整恢复。
- **完整回退**：停止服务 → 恢复产品库与执行库备份 → 恢复 `runtime` 备份 → 启动。不要保留只升级了一半的数据库或只换了一半的运行目录；旧 SDK 不能打开升级后的存储。
- 导入不改 `app_cover`、`deploy_key`、版本仓库或用户密码。封面/部署键仍由 `db:import` 的 `--covers` 与旧发布目录负责。

## 已知限制

1. 旧版本行不补交付。历史恢复命中 legacy 版本时会重新构建并独立物化；构建失败保持原预览，不追加版本行。
2. 不导入旧聊天/文本消息，也不把旧工具调用补造成新转录。
3. 只导入当前工作区作为一份草稿；旧“发布版与工作区不一致”的事实不伪造，交付内容取自 `code_output`（工程类型取当次 `dist`）。
4. Vue/React 工程类型若没有 `dist/index.html` 会被跳过；先在旧环境重新构建发布，或接受该应用暂不导入预览。
5. 源目录含符号链接、平台敏感文件或超过配额时该应用失败并返回非零；不会静默裁剪后继续。
6. 本工具不执行 `npm run db:migrate`、不启动/停止进程、不做生产切换。生产前先在测试库与运行目录副本执行完整预演。

## 切换演练清单

1. 在测试环境恢复产品库/执行库与 `runtime` 副本，跑 `npm run db:migrate`。
2. `npm run legacy:import -- --runtime <副本>`：确认输出只有导入/跳过，没有失败。
3. `npm run legacy:import -- --apply --runtime <副本>`：按上文 SQL 核对交付、指针、草稿、authority，确认没有新增 `version_record`/`generation`。
4. 再跑一次 `--apply`：确认全部跳过或修复，交付数与 revision 不变。
5. 启动预览服务，逐个打开有旧预览的应用；确认页面与切换前一致，且 `deliveries/` 中不包含 `.env`、`node_modules`。
6. 触发一轮生成（测试环境），确认新执行目录的基线来自 `source_snapshot(kind=draft)`，而不是重新读取旧工作区。
7. 用备份完整恢复一次，确认回退路径可用；记录耗时与失败项。

演练通过后再按[已归档的 harness 可靠性计划 §6](archive/harness-reliability.md)的生产切换顺序执行：停止新准入 → 排空旧执行 → 备份 → 迁移 → `db:import` → `legacy:import` → 启动新协议 → 引用核对。核对失败时不开放生成。
