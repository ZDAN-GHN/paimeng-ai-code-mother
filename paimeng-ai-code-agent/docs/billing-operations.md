# Credit 计费的运行说明

Credit 有两个运维面：**月度配额**（发放、补发、查账）与**补结算/余额对账**（漏账补记、待处理重试、快照核对）。
两个面都没有常驻定时器：触发点都在请求路径、Admin 入口或外部 cron 调的 CLI 上。

## 月度配额

按 [ADR-0004](adr/0004-credit-billing.md) 的「Two pools, deducted quota first」实现的月度配额，操作面只有三件事：什么时候发、怎么补、怎么核对。代码在 `src/server/billing/quota.ts`。

### 账期口径

- 账期是**北京时间自然月**（UTC+8，没有夏令时），字符串形如 `2026-11`。北京时间每月 1 号 00:00 之后属于新账期，见 `src/server/billing/period.ts`。
- 每个账期给每个用户发放 **500 Credit** 到配额池（`monthlyQuotaCredits`，`src/shared/billing.ts`）。
- 配额**不累积、不结转、不折现**：新账期开始时配额池余额按账本事实重算成「当期 grant − 当期扣减」，上一期没用完的部分直接失效。余额池与购买历史不受账期影响。
- 没有新表：幂等键就是 `credit_grant` 上已有的部分唯一索引 `uk_credit_grant_monthly (user_id, period) WHERE source = 'monthly_quota'`（迁移 `010_credit_grant_account.sql`）。

### 什么时候会发

发放是**懒触发**的，仓库里没有常驻定时器：

| 触发点 | 位置 | 说明 |
| --- | --- | --- |
| 注册 | `src/server/auth/auth.ts` 的 `register()` | 注册成功即发当月配额；发放失败只记日志，不影响注册 |
| 读额度摘要 | `GET /api/billing/summary` | 返回前先确保当期配额，所以停机错过月初的用户打开页面就补上 |
| 批量补发 | `npm run billing:quota-issue` | 见下节 |

三者都调用 `ensurePeriodQuota`，并发或重跑都不会多发。

### 补发

前提：产品库已经迁移到最新（`npm run db:migrate`），配额发放要用的 `credit_grant` / `credit_account` 才存在。

```bash
cd paimeng-ai-code-agent
npm run billing:quota-issue                 # 试运行：只报「待发放用户数」，不写库
npm run billing:quota-issue -- --apply      # 真正发放
npm run billing:quota-issue -- --apply --limit=200
```

- 默认试运行，`--apply` 才写库；脚本自己校验目标库只能是 `paimeng_app` 或 `paimeng_app_test`。
- 一次最多处理 1000 个用户（`--limit` 可改），剩下的下一次继续——幂等所以不需要记录进度。「待发放用户」= 没有这一期 `monthly_quota` grant 且未删除的用户。
- 需要每月自动跑时，用外部 cron / systemd timer 调这条命令（本仓不带 scheduler）：
  ```cron
  10 0 1 * * cd /path/to/paimeng-ai-code-agent && npm run billing:quota-issue -- --apply
  ```
  时间取北京时间 1 号 00:10；即使漏跑或重跑，下一次任何人读额度摘要时也会补当期。

### 核对

配额余额是余额快照（`credit_account.pool = 'quota'`），真值在 `credit_grant`（发放）与 `credit_entry`（扣减，归属看父 Charge 的 `create_time`）。查某个用户：

```bash
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select period, credits, create_time from credit_grant where user_id = 123 and source = 'monthly_quota' order by period"
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select pool, balance, update_time from credit_account where user_id = 123 order by pool"
```

- 一个用户在一个账期里最多一行 `monthly_quota` grant；多行说明有人绕过 `ensurePeriodQuota` 直接写库。
- 当期配额池余额 = 当期 `monthly_quota` grant 之和 − 当期 Charge 的 `pool = 'quota'` entry 净额。
- 有效期的展示口径：北京时间下一个 1 号 00:00，首页与对话页的额度条读的就是它。

## 补结算与余额对账

终态事务已提交、结算没落地（或进程正好在两者之间被杀）的 Generation 不会自己产生账单——没有别的路径会再通知计费。补结算把这类漏账补上，并给「缺费率」「晚到用量」的账单补差额。代码在 `src/server/billing/settlement.ts`；账本口径见 `src/server/billing/ledger.ts` 的注释与 [ADR-0004](adr/0004-credit-billing.md)。

### 扫描口径

只处理两类身份，重复扫描不会重复扣费（按 `usage_snapshot.stepId` 去重，差额只在总额层四舍五入一次）：

| 身份 | 条件 | 处理 |
| --- | --- | --- |
| 终态缺账 | `generation.status in ('ready','failed','cancelled')` 且没有 `credit_charge` 行 | 走首次结算：建账单、定价、分池扣款 |
| 待补账单 | `credit_charge.status in ('unpriced','partial')`，或模型步骤的 id 还没进 `usage_snapshot` | 只给「没进过账」的步骤补记差额，追加 `credit_entry` 后重算投影 |

- `generating` / `building` **永远不算终态**，扫描不碰。
- `reversed`（平台故障已整笔退还）的账单不再补扣，即使之后又出现晚到步骤。
- 补结算只追加 entry，不改写已计价步骤、不重排 `generation_id` 唯一的那张账单；金额为 0 的补记不写 entry。
- 缺费率或缺估算样本时账单保持 `unpriced`/`partial`，原因写进 Admin 列表与扫描结果；补齐 Rate card 后下一次扫描会补上，不会永久跳过。

### 什么时候会跑

没有常驻定时器，三个入口都调同一个幂等函数：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| 启动屏障 | `durable-engine.ts` 的 `ensureRecovered()` | 恢复完成后跑一次 `reconcileSettlements({ limit: 50 })`，`void` + 记日志，失败不影响恢复 |
| Admin | `GET` / `POST admin/billing/reconcile` | 页面 `/admin/billing` 的「补结算与核对」分区：列待处理、按条或整批重试 |
| CLI | `npm run billing:reconcile` | 见下节；批量补也可以用外部 cron 调它 |

### CLI

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

### 余额核对与修复

预期余额由账本事实推出（`ledger.ts` 的 `expectedBalancesOf`）：

- 配额池 = 当前北京账期的 `monthly_quota` grant 之和 − 当期 Charge 的 `quota` entry 净额（entry 归账期看父 Charge 的 `create_time`）；永不为负。
- 余额池 = 全部 `balance` grant 之和 − 全部 `balance` entry 净额；可以是负数（欠款）。

`auditAccount(userId)` 只报告 `expected` / `actual` / `diff`（`diff = actual − expected`），不写库。修复用 `rebuildAccount(userId)`：先锁两池，再按事实重写快照——差异能由账本解释，账本事实本身一行都不改。手工改 `credit_account` 抹平差异属于事故，不是修复。

### 排查

```bash
# 某条账单的步骤身份与状态
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select generation_id, status, credits, jsonb_array_length(usage_snapshot) from credit_charge where generation_id = '<id>'"
# 某条账单的分录（正扣负退）
docker exec -i zslm-postgres psql -U postgres -d paimeng_app -c \
  "select id, pool, credits, reason, create_time from credit_entry where charge_id = '<id>' order by id"
```
