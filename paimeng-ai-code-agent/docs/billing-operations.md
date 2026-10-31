# Credit 补结算与余额对账的运行说明

终态事务已提交、结算没落地（或进程正好在两者之间被杀）的 Generation 不会自己产生账单——没有别的路径会再通知计费。补结算把这类漏账补上，并给「缺费率」「晚到用量」的账单补差额。代码在 `src/server/billing/settlement.ts`；账本口径见 `docs/specs/credit-billing.md` 与 `04-settlement-design.md`。

## 扫描口径

只处理两类身份，重复扫描不会重复扣费（按 `usage_snapshot.stepId` 去重，差额只在总额层四舍五入一次）：

| 身份 | 条件 | 处理 |
| --- | --- | --- |
| 终态缺账 | `generation.status in ('ready','failed','cancelled')` 且没有 `credit_charge` 行 | 走首次结算：建账单、定价、分池扣款 |
| 待补账单 | `credit_charge.status in ('unpriced','partial')`，或模型步骤的 id 还没进 `usage_snapshot` | 只给「没进过账」的步骤补记差额，追加 `credit_entry` 后重算投影 |

- `generating` / `building` **永远不算终态**，扫描不碰。
- `reversed`（平台故障已整笔退还）的账单不再补扣，即使之后又出现晚到步骤。
- 补结算只追加 entry，不改写已计价步骤、不重排 `generation_id` 唯一的那张账单；金额为 0 的补记不写 entry。
- 缺费率或缺估算样本时账单保持 `unpriced`/`partial`，原因写进 Admin 列表与扫描结果；补齐 Rate card 后下一次扫描会补上，不会永久跳过。

## 什么时候会跑

没有常驻定时器，三个入口都调同一个幂等函数：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 启动屏障 | `durable-engine.ts` 的 `ensureRecovered()` | 恢复完成后跑一次 `reconcileSettlements({ limit: 50 })`，`void` + 记日志，失败不影响恢复 |
| Admin | `GET` / `POST admin/billing/reconcile` | 页面 `/admin/billing` 的「补结算与核对」分区：列待处理、按条或整批重试 |
| CLI | `npm run billing:reconcile` | 见下节；批量补也可以用外部 cron 调它 |

## CLI

前提：产品库已经迁移到最新（`npm run db:migrate`），补结算要用的 `credit_charge` / `credit_entry` 才存在。

```bash
cd paimeng-ai-code-agent
npm run billing:reconcile                          # 试运行：列出待补结算的记录与原因
npm run billing:reconcile -- --apply               # 执行补结算
npm run billing:reconcile -- --apply --limit=200   # 一次最多处理 200 条（默认 50，上限 200）
npm run billing:reconcile -- --user 123            # 核对某个用户的两池余额
npm run billing:reconcile -- --user 123 --apply    # 按账本事实重写该用户的余额快照
```

- 默认试运行，`--apply` 才写库；脚本自己校验目标库只能是 `paimeng_app` 或 `paimeng_app_test`。
- `--user` 只核对，不动账；带 `--apply` 时才重写 `credit_account` 快照（账本事实 `credit_grant` / `credit_entry` 永不 UPDATE/DELETE）。
- 需要定期补时用外部 cron 调 CLI（本仓不带 scheduler），例如每小时一次：
  ```cron
  7 * * * * cd /path/to/paimeng-ai-code-agent && npm run billing:reconcile -- --apply
  ```

## 余额核对与修复

预期余额由账本事实推出（`ledger.ts` 的 `expectedBalancesOf`）：

- 配额池 = 当前北京账期的 `monthly_quota` grant 之和 − 当期 Charge 的 `quota` entry 净额（entry 归账期看父 Charge 的 `create_time`）；永不为负。
- 余额池 = 全部 `balance` grant 之和 − 全部 `balance` entry 净额；可以是负数（欠款）。

`auditAccount(userId)` 只报告 `expected` / `actual` / `diff`（`diff = actual − expected`），不写库。修复用 `rebuildAccount(userId)`：先锁两池，再按事实重写快照——差异能由账本解释，账本事实本身一行都不改。手工改 `credit_account` 抹平差异属于事故，不是修复。

## 排查

```bash
# 某条账单的步骤身份与状态
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select generation_id, status, credits, jsonb_array_length(usage_snapshot) from credit_charge where generation_id = '<id>'"
# 某条账单的分录（正扣负退）
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select id, pool, credits, reason, create_time from credit_entry where charge_id = '<id>' order by id"
```
