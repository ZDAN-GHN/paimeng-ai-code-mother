# Credit 计费

## Problem Statement

现在每一次 Generation 都在真实花钱，但产品里没有任何地方能回答"这一次花了多少"。Owner 可以无限生成，看不到任何用量；Admin 看不到某个用户的消耗，也算不出毛利。唯一的约束是 Harness 的调用次数 Budget（24 次模型调用、400 次工具调用、2 次 self-check build），它能在模型跑飞时踩刹车，却不记录代价，也无法区分"合理的长生成"和"被滥用的免费算力"。

对 Owner 来说，问题具体是：我不知道这个产品会不会突然找我收钱、我不知道我还能生成几次、我甚至不知道我已经用掉了多少。对一个要长期运营的产品，这是不可持续的——要么永远免费，要么某天突然开始收费而用户毫无准备。

## Solution

引入 Credit 作为用户可见的用量单位，价格由真实 token 用量折算，账单在每次 Generation 结束后立刻可见。

Owner 打开任何一个 App 的对话，就能在每次助手回复下面看到"本次消耗 N Credit"。另有一页用量与额度：本月配额还剩多少、余额还有多少、月底会清零多少、每次生成的账单明细。配额每月自动发放，用尽后自动从余额扣，余额也不足时在开始生成前就被明确拦住，并直接告诉他充值后继续。

Admin 能看到每个用户的用量、近 60 天购买总额、当前透支线、以及每次生成的真实成本（USD）与售价（Credit），从而知道毛利在哪。Admin 可以给用户发放余额（区分"购买"和"补偿"）、手工冲正一笔错误的扣费、维护按模型分列的 Rate card——上游改价时不需要改代码。

计费是这一轮唯一新增的产品面；支付渠道不在本次范围内，充值暂时由 Admin 后台发放代行。

## User Stories

1. 作为一个刚注册的 Owner，我希望注册后立刻拿到当月配额，这样我不必先付钱就能跑通第一次生成。
2. 作为一个 Owner，我希望在每次 Generation 结束后看到它消耗了多少 Credit，这样我知道钱花在哪里。
3. 作为一个 Owner，我希望看到本月配额还剩多少，这样我能判断还能生成几次。
4. 作为一个 Owner，我希望配额池和余额池分开展示，这样我知道哪一部分会在月底清零。
5. 作为一个 Owner，我希望知道"本月剩余额度月底清零、不累积"，这样我不会攒着不用。
6. 作为一个 Owner，我希望配额用尽后自动改从余额扣减，这样一次生成不会因为配额刚好归零而中断。
7. 作为一个 Owner，我希望看到账单被拆成"配额 N + 余额 M"，这样我能理解为什么余额减少得比预期慢。
8. 作为一个 Owner，我希望余额也不足时在开始生成之前就被拦住，这样我不会等半天才拿到一个失败结果。
9. 作为一个 Owner，我希望被拦住时看到明确的下一步（充值 / 联系管理员），而不是一句"额度不足"。
10. 作为一个 Owner，我希望一次生成因为超出透支线被中途中止时，看到一条说明它为什么停下，而不是一个普通的"生成失败"。
11. 作为一个 Owner，我希望被中止的那次生成按实际已用量收费，而不是按预估上限收费。
12. 作为一个 Owner，我希望每一次生成都有一条不可篡改的账单记录，这样我可以事后核对，也相信它没被改过。
13. 作为一个 Owner，我希望 Usage 无法从上游取得、账单只能估算时，界面上明确标出"估算"，这样我不会把估算当成精确值。
14. 作为一个 Owner，我希望平台自身故障（初始化失败、写权限丢失）导致的扣费被自动退回，这样我不为平台的 bug 付钱。
15. 作为一个 Owner，我希望我主动取消的生成按已用量收费并且能看到理由，这样我不觉得被隐藏收费。
16. 作为一个 Owner，我希望模型出错或超时的生成也照实计费但能看到它用在了哪，因为那确实是真实消耗。
17. 作为一个 Owner，我希望在写需求之前大概知道一次生成值多少钱的量级，这样我能判断这个产品我用不用得起。
18. 作为一个 Admin，我希望给指定用户发放余额，这样在还没有支付渠道时也能完成一次"购买"。
19. 作为一个 Admin，我希望在发放时标明这是"购买"还是"补偿"，这样透支基数和营收报表才准。
20. 作为一个 Admin，我希望看到某个用户的配额、余额、近 60 天购买总额和当前透支线，这样我能判断这个账号的风险。
21. 作为一个 Admin，我希望看到每次 Generation 的真实成本（USD）和售价（Credit），这样我能算出毛利。
22. 作为一个 Admin，我希望手工冲正一笔 Charge，且冲正只追加反向分录、不删除原记录，这样账本始终可审计。
23. 作为一个 Admin，我希望按模型维护 Rate card 并且每条费率带生效时间，这样上游调价时我改配置就行。
24. 作为一个 Admin，我希望看到 Usage 缺失（估算）的比例，这样我能尽早发现上游返回用量的问题。
25. 作为一个 Admin，我希望月末配额发放任务可以安全重跑，这样重复执行不会给用户多发额度。
26. 作为一个平台运营者，我希望结算对同一个 Generation 只发生一次，这样进程重启或事件重放都不会重复扣费。
27. 作为一个平台运营者，我希望有一个对账扫描把漏结算的 Generation 补上，因为终态写入分散在多条路径上，漏掉一条就是直接漏账。
28. 作为一个平台运营者，我希望每次结算都把当时的 Rate card 版本和 cost_usd 一起落库，这样改价之后历史毛利仍然算得出来。
29. 作为一个 Harness 运行时，我希望在生成过程中逐步评估已消耗的 Credit，这样透支线才能在被超过的那一刻触发中止，而不是等到结束才发现。

## Implementation Decisions

### 单位与价格

- Credit 是用户可见单位，面额固定 1 Credit = ¥0.01，不可兑换、不可提现、不参与货币运算。面值是**不可变承诺**：改价只能改 Rate card，不能改面额，否则所有历史账单的语义都会变。
- Rate card 按上游模型分列，三个费率分别对应 `input_tokens`（cache miss）、`cache_read_tokens`（cache hit）、`output_tokens`，单位为 Credit / 1M tokens。`cache_write_tokens` 与 `reasoning_tokens` 不单独计价：前者当前上游为 0，后者由 `output_tokens` 覆盖，重复计入会双重收费。
- 定价基准是上游**峰时**价乘 Markup（当前 3 倍）。谷时差价是毛利缓冲，不作为定价依据。输入:输出比价保持上游的 1:4。
- 初始费率（Credit / 1M tokens）：`deepseek-flash` = 未命中 600、命中 12、输出 2500；`deepseek-v4-pro` = 未命中 2600、命中 50、输出 8500。
- build、联网搜索、页面抓取、部署不单独计价，成本由 Markup 吸收。`Budget` 已经限制了失控的 build，不需要计费再拦一遍。
- Rate card 带 `effective_from`，解析时取"该步骤发生时刻生效的最高版本"。查不到费率的模型视为配置错误，Charge 标记为 `unpriced` 并告警，不以 0 计费。

### 账本

五张新表，各管一件事：价格、入账、余额快照、出账、分录。每张表存在的理由都是「没有它，这件事就无处记录」—— 写不出这个理由就不该拆表。

- **`credit_rate_card`** — 价格表。
  用途：回答“这个模型的 token 现在值多少 Credit”。没有它，三个费率只能写在代码里，上游改一次价就要发一次版，而且改完之后历史 Charge 无法解释。
  列：(`provider_id`, `model_name`, `effective_from`) 唯一，缓存未命中输入 / 命中输入 / 输出三个整数费率（Credit / 1M tokens）。追加写入，不修改已有行。
- **`credit_grant`** — 入账记录。
  用途：Credit 进入系统的**唯一**入口，也是“这笔额度从哪来”的唯一答案。余额、可用额度、透支基数三个数全部从它推导，所以它必须分得清 `purchase` 与 `admin_grant`——前者算透支基数，后者不算。
  列：`user_id`、`pool`（`quota` / `balance`）、`credits`、`source`（`purchase` / `admin_grant` / `monthly_quota`）、`external_ref`（可空，留给将来的支付单号）、`granted_by`（管理员，可空）、`period`（仅月度配额用）、`create_time`。`monthly_quota` 以 (`user_id`, `period`) 唯一，保证月度发放幂等。
- **`credit_account`** — 余额快照。
  用途：回答“这个用户此刻能用多少”，并让“判断能不能开始”和“扣减”在同一次加锁读取里完成。它**不是** Credit balance：`Credit balance` 是两池之和（用户看到的数），而这里每个 (`user_id`, `pool`) 一行。存在的唯一理由是写入原子性；它的值任何时候都能由 `credit_grant` 减 `credit_entry` 重算，所以对账时它是对账对象，不是真相来源。
  列：(`user_id`, `pool`) 主键，`balance`（可为负，仅 `balance` 池）、`update_time`。
- **`credit_charge`** — 出账聚合根，一次 Generation 一行。
  用途：回答“这一次生成收了多少钱、按什么价收的、算得准不准”。它是用户账单上那一行，也是 `generation_id` 唯一约束所在——幂等、对账、冲正全挂在这一行上。
  列：`generation_id`（**唯一**）、`app_id`、`user_id`、`credits`（整数，四舍五入后）、`cost_usd`、`rate_card_snapshot`（本次实际用到费率的 JSON 副本，用于改价后仍能解释历史）、`status`（`settled` / `estimated` / `unpriced` / `reversed` / `partial`）、`create_time`。
- **`credit_entry`** — 出账分录，一次 Charge 按池拆成多行。
  用途：回答“这笔钱从哪个池扣的、退回到哪里去”。把配额和余额抹成一条总量的代价是退款分不清回哪个池、月底统计不出“本月用掉多少配额”，而且以后想加第三个池就要重算历史。
  列：`charge_id`、`pool`、`credits`（正数为扣减，负数为退还）、`reversal_of`（可空，指向被冲正的 entry）、`create_time`。冲正永远是新增一条反向 entry，绝不 `UPDATE` 或 `DELETE`。

余额语义：`配额池余额 + 余额池余额` 是用户看到的 Credit balance。配额池永不为负；负数只可能来自余额池，表示欠款。

### 结算

- **唯一入口是 `settleGeneration(generationId)`**，幂等性由 `credit_charge.generation_id` 唯一约束保证（插入冲突即视为已结算，直接返回）。它必须从**每一条**把 Generation 写成终态的路径调用——目前这些路径分散在多处，且 `finishGeneration` 是死代码。另有一个对账扫描兜底，处理漏调的 Generation。
- **结算在结束后发生，不预扣**。Charge 的计算方式是：读取该 Generation 全部 `generation_steps` 里 `kind = 'model'` 的行，逐行按 (`provider_id`, `model_name`, 步骤时刻) 解析费率，累计浮点后**在 Charge 层四舍五入一次**得到整数 Credit。不在每个步骤上取整，避免累积误差。
- **扣减在单个事务内完成**：`SELECT ... FOR UPDATE` 锁住该用户的 `credit_account` 两行，先配额池后余额池，写 entry，更新 account。同一 Owner 可以在多个 App 上并发生成，所以必须原子。
- **结束时余额为负不阻止结算**，只把欠款写实。透支判断是下一节的事。
- **终态归责**：`initialization-failed` 与 `lease-lost` 判为平台故障，结算后立即整笔冲正（对每条 entry 追加反向 entry，`charge.status` 置为 `reversed`）。其余终态——`cancelled`、`model-error`、`timeout`、`interrupted`、`verification-failed`、`no-changes`、`completed`、`step-limit`、`question`——一律按实收，不需要人工介入。
- **Usage 缺失**时按同一次 Generation 内已知模型的平均 token 数估算未知步骤，`charge.status = 'estimated'`。估算结果同样落库，界面标注"估算"。

### 透支与准入

- `Overdraft = 近 60 天 source = 'purchase' 的 credit_grant 总额 × 2%，封顶 500 Credit`。`admin_grant` 与 `monthly_quota` 不计入基数；无 purchase 记录则为 0。
- 透支线是**熔断线**，不是准入额度。判断时机在生成**过程中**：Harness 每完成一个模型步骤，就地把"该 Generation 已消耗（含未结算部分）"累加到 Owner 当前可用额度上，一旦欠款超过透支线，立即中止这次 Generation（`stop_reason` 取一个明确区别于普通失败的值），随后正常结算实际用量。
- 因此需要一个**运行期累计量**：结算只在终态发生，但中止决定必须在运行中做出，所以过载评估与 Charge 写入是两个不同的路径，不能合并。
- **准入判断**在提交生成之前：可用 Credit（配额 + 余额）`<= 0` 时拒绝开始，返回一个可被界面识别的错误码，附带"充值 / 联系管理员"的恢复指引。欠款状态下不允许开始新的 Generation。
- 透支线**只降不追**：60 天窗口里旧 purchase 滑出导致透支线下降时，不做任何补扣，只是让"欠款超线"这个状态生效。

### 配额

- 每月北京时间 1 号 00:00 之后，为每个尚无本期 `monthly_quota` grant 的用户发放 500 Credit 到配额池。幂等键是 (`user_id`, `period`)，重跑安全。
- 新注册用户立即获得当月配额，不等下一个 1 号。
- 配额不累积、不结转、不折现；过期即失效。界面上必须明说这一点。

### 模块与接口

新增 `src/server/billing/`，按职责切分：

- `rate-card.ts`：费率表读取、按时刻解析、管理员维护。
- `pricing.ts`：`Usage → Credit` 的纯函数。输入是步骤用量数组与解析出的费率，输出分池前的整数 Credit 与 `cost_usd`。不碰数据库。
- `ledger.ts`：grant / charge / entry 的写入、冲正、余额重算。所有写操作只追加。
- `settlement.ts`：`settleGeneration`、运行期过载评估、月度配额发放、对账扫描。
- `admin.ts`：管理员发放、冲正、费率维护的用例入口。

对外 HTTP 契约（JSON，沿用现有响应信封）：

- `GET /api/billing/summary` → 配额池、余额池、本期配额有效期、透支线、近 60 天购买总额。
- `GET /api/billing/charges?appId=…&limit=…` → 该 App 的 Charge 列表与分池 entry。
- `POST /api/admin/billing/grant` → `{ userId, pool, credits, source, note }`。
- `POST /api/admin/billing/charge/:id/reverse` → `{ reason }`。
- `GET /api/admin/billing/rate-card` / `PUT /api/admin/billing/rate-card` → 带 `effective_from` 的费率列表。
- `GET /api/admin/billing/usage?userId=…` → 该用户的 Charge、成本、估算比例。

Generation 提交接口需要新增一个失败分支：额度不足时返回专用错误码，不复用通用失败。

### 界面上必须出现的三件事

1. 每次助手回复下的用量（整数 Credit；估算时带"估算"字样）。
2. 额度条：本月配额剩余、余额、月底清零提示。
3. 被中止的生成有独立的停止原因文案，和普通失败分开。

## Testing Decisions

好的测试只断言**外部可观察的行为**，不断言内部实现：给定一组 `generation_steps` 和一张 Rate card，断言账本里出现了一条 Charge 和正确的分池 entry；给定一个用户的配额与余额，断言准入判断的结果；给定重复调用结算，断言只产生一条 Charge。不去断言"调用了 `ledger.write` 三次"这种实现耦合。

两个测试接缝，理由写在后面：

1. **结算接缝（主）——对真实 Postgres 断言账本。** 所有计费行为都在 `settleGeneration` 这个边界上可观察：Charge 行、entry 行、account 余额、幂等性、冲正、透支中止的判定。测试放在 `tests/integration/billing/`，用 `_test` 数据库，`support/test-database-url.ts` 校验 URL。先例是 `tests/integration/generation/generation-budget.test.ts`——那组测试同样以"插入真实行、调用真实函数、断言真实表"的方式验证预算。
2. **定价接缝（辅）——纯函数。** `pricing.ts` 的输入输出是纯数据，边界情况密集（缓存命中与未命中混排、多模型混排、零 token、四舍五入、Usage 缺失估算、查不到费率）。逐个通过数据库验证代价太高且噪音大。测试放在 `tests/unit/billing/`，先例是 `tests/unit/generation/generation-accounting.test.ts`——那组测试正是对同一批 token 数据的聚合逻辑做纯函数断言。

为什么不是**一个**接缝：定价的边界情况大约有十几个，全部塞进序列化执行的集成套件会让反馈变慢，而它们本质上是纯计算，没有服务依赖。为什么不要**三个**：HTTP 层不需要独立接缝——`tests/integration/platform/http.test.ts` 已有的接口契约测试会在新增端点时自然覆盖，不为计费单开一套。

需要浏览器验证的部分（对话里的用量展示、额度条、被中止生成的状态）走 `tests/e2e/`，沿用现有 Playwright 结构和 `e2e/support/` 的辅助函数。

## Out of Scope

- 真实支付渠道（Stripe / 支付宝 / 微信）与回调对账。充值暂时由 Admin 发放代行。
- 订阅套餐、升降级、续费、试用期、配额按套餐分档。
- 退款到货币、Credit 提现、Credit 转账。
- 按 CPU 秒或容器内存计量 build 成本。
- 发票、税务、多币种结算。
- 汇率自动更新：`cost_usd` 与人民币售价之间的人工维护汇率不在本期实现，Markup 已为此留了余量。
- 前端视觉重构：用量展示沿用现有对话组件与设计语言，本次只增加信息，不改版式体系。

## Further Notes

- **定价参数目前全是估算，没有真实数据支撑。** 典型生成的 token 数量、缓存命中率、峰值时段的占比都还没有实测。建议第一个里程碑就把 Charge 落库并展示，但暂不打开准入拦截，用一到两周的真实账单校准 Markup 和月度配额，再启用扣减侧的硬规则。
- **两个看起来像缺陷的行为是刻意设计**：跑飞的 Generation 必然被中途中止（500 Credit 的透支封顶只有最坏情况的三分之一），普通用户的透支额接近 0（2% 只有在充值超过 ¥250 时才抵到封顶）。已被 ADR 0004 记录，改动前先读它。
- **终态写入路径分散是本轮的主要实现风险**。`finishGeneration` 目前没有任何调用点，终态状态由多条路径直接 `UPDATE`。结算漏挂一条路径就是直接漏账，所以对账扫描不是可选的补丁，而是结算的一部分。
- `docs/` 下目前没有 `specs/` 目录，本文是它的第一份文件；`docs/AGENTS.md` 的布局章节还没有登记这个目录，需要在实施时一并补上。
- 相关决策见 `docs/adr/0004-credit-billing.md`；术语见根目录 `GLOSSARY.md` 的「计费」一节。
