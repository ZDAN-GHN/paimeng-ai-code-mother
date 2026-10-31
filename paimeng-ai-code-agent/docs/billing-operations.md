# Credit 月度配额的运行说明

按 [ADR-0004](adr/0004-credit-billing.md) 与规格 [`credit-billing`](specs/credit-billing.md) 的「配额」一节实现的月度配额，操作面只有三件事：什么时候发、怎么补、怎么核对。代码在 `src/server/billing/quota.ts`。

## 账期口径

- 账期是**北京时间自然月**（UTC+8，没有夏令时），字符串形如 `2026-11`。北京时间每月 1 号 00:00 之后属于新账期，见 `src/server/billing/period.ts`。
- 每个账期给每个用户发放 **500 Credit** 到配额池（`monthlyQuotaCredits`，`src/shared/billing.ts`）。
- 配额**不累积、不结转、不折现**：新账期开始时配额池余额按账本事实重算成「当期 grant − 当期扣减」，上一期没用完的部分直接失效。余额池与购买历史不受账期影响。
- 没有新表：幂等键就是 `credit_grant` 上已有的部分唯一索引 `uk_credit_grant_monthly (user_id, period) WHERE source = 'monthly_quota'`（迁移 `010_credit_grant_account.sql`）。

## 什么时候会发

发放是**懒触发**的，仓库里没有常驻定时器：

| 触发点 | 位置 | 说明 |
| --- | --- | --- |
| 注册 | `src/server/auth/auth.ts` 的 `register()` | 注册成功即发当月配额；发放失败只记日志，不影响注册 |
| 读额度摘要 | `GET /api/billing/summary` | 返回前先确保当期配额，所以停机错过月初的用户打开页面就补上 |
| 批量补发 | `npm run billing:quota-issue` | 见下节 |

三者都调用 `ensurePeriodQuota`，并发或重跑都不会多发。

## 补发

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

## 核对

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
