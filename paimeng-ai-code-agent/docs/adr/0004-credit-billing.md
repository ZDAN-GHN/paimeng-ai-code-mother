# Bill generations in Credits derived from real token usage

- Status: accepted
- Date: 2026-10-30

## Context

Generation cost is real but unmeasured. Every model step already records `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, and `reasoning_tokens` in `generation_steps`, and `generation-accounting.ts` aggregates them — but nothing turns those numbers into money. The only existing limits are call-count budgets in the harness (`24` model calls, `400` tool calls, `2` self-check builds), which stop runaway loops without recovering their cost. `model-domain.ts` carries a `generationModelCost` constant that happens to equal DeepSeek Flash's **off-peak** price for every model, so it cannot be used as a bill source: peak is 2x, and a different model can be 4-8x.

Upstream reference (DeepSeek `deepseek-flash`, 2026-10): cache-miss input $0.15/$0.30, cache-hit input $0.003/$0.006, output $0.60/$1.20 per 1M tokens, off-peak/peak.

## Decision

**Credit is the unit users see.** Fixed denomination of 1 Credit = ¥0.01, not a currency balance, not convertible, not withdrawable. Changing the denomination would change the meaning of every historical charge, so it is treated as immutable and prices move in the Rate card instead.

**Usage converts to Credit through a Rate card**, not through code constants. Each entry is per model with separate input / cache-hit / output rates, priced at **3x the upstream peak cost** (peak, not off-peak: off-peak discount is margin, not a promise). The input-to-output ratio keeps upstream's 1:4 rather than being flattened, because long context is the dominant cost of this product and discounting it would lose money on exactly the users who cost most. Current table, Credit per 1M tokens:

| model | input (miss) | input (cache hit) | output |
| --- | --- | --- | --- |
| `deepseek-flash` | 600 | 12 | 2500 |
| `deepseek-v4-pro` | 2600 | 50 | 8500 |

Non-token costs (self-check and platform builds, web search, fetch, deployment) are **not** separately priced. They are absorbed by the 3x markup: a build is worth about ¥0.05 against a typical ¥1.55 generation charge, and exposing "构造 ×3" to non-technical users costs more in confusion than it recovers. Runaway builds are already bounded by Budget.

**Two pools, deducted quota first.** The quota pool is granted monthly (500 Credit, reset at 00:00 Beijing time on the 1st, non-accumulating, never negative). The balance pool holds top-ups and admin grants, never expires, and is the only pool that may go negative. A single `Credit charge` per Generation is the aggregate root; `Credit entry` rows split it by pool, so a 3-Credit quota remainder plus a 12-Credit balance draw are one bill with two auditable lines.

**Settlement happens after the Generation ends, not before it starts.** There is no pre-authorization. Charging requires knowing actual usage, and a worst-case generation costs ~1600 Credit (24 model calls at the context budget), which no user could sensibly pre-pay.

**Overdraft is a circuit breaker, not a credit limit.** `Overdraft = 2% of purchase top-ups in the trailing 60 days, capped at 500 Credit`; `admin_grant` does not count, because a goodwill grant must not widen a user's overdraft. When a settlement pushes the debt past the overdraft line, the **running Generation is aborted** and then charged for what it actually used.

**Outcome decides reversibility, not amount.** Every terminal generation is charged for real usage regardless of result — `cancelled`, `model-error`, `timeout`, `interrupted`, `verification-failed`, `no-changes` all pay, because the tokens were consumed and free failures are a free compute faucet. Only `initialization-failed` and `lease-lost` are treated as platform faults and reversed. Reversal is a compensating entry pointing at the original entry; nothing is ever deleted or updated.

**Unknown usage is estimated, never zero.** When a step has no upstream usage, its tokens are imputed from the mean of the generation's known steps and the charge is marked `estimated`, visible as such in the UI.

## Alternatives considered

- **Fixed Credit per Generation (v0's actual model)**: predictable for users, but this product's generation length is unbounded and the platform would eat every runaway.
- **Pre-authorizing a maximum before start**: the true maximum is 24 calls times the context window — tens of dollars. Any affordable pre-auth is not a real ceiling, so the guarantee is fake.
- **Killing the generation as soon as the balance hits zero**: users pay 20 rounds and receive nothing usable; the worst possible outcome for the money spent.
- **Charging only `completed` generations**: any reliably failing input becomes a free way to burn compute.
- **Recording missing usage as zero**: contradicts the existing diagnostic rule that unknown usage must not be recorded as zero, and creates an incentive to make usage disappear.
- **Metering build CPU-seconds**: precision far below what the user can perceive, at the cost of a whole resource-measurement pipeline.
- **No overdraft at all**: honest and simpler, but rejected because the chosen numbers already behave almost like this (see Consequences), and keeping the parameter leaves room for a future subscription tier.

## Consequences

- **A runaway generation will be terminated mid-flight.** 500 Credit is a third of the ~1600 Credit worst case, so this is the default outcome, not an edge case. This is a deliberate choice in favour of bounded financial exposure over a complete result, and it should not be "fixed" later without revisiting this ADR.
- **Overdraft is close to zero for ordinary users.** 2% only reaches the 500 cap above ¥250 of top-ups; a ¥10 buyer gets 20 Credit. The overdraft mechanism therefore behaves as settlement precision, not as leniency.
- **Terminal state writes are scattered** across `durable-engine.ts`, `control-store.ts`, and `generation-store.ts` (`finishGeneration` is currently uncalled). Settlement must be a single idempotent entry point keyed by a unique constraint on `generation_id`, invoked from every terminal path, with a reconciliation sweep as backstop. Missing one path silently loses money.
- **The ledger is append-only.** `credit_charge`, `credit_entry`, `credit_topup` are never updated. Refunds are compensating entries. Every charge stores the Rate card version and the `cost_usd` it implies, so historical margin stays computable after a price change.
- **Payment is out of scope for this phase**, but the top-up table already distinguishes `purchase` from `admin_grant` and carries a nullable external reference, so wiring a payment callback later is a new caller of the same credit function, not a ledger change.
- **Changing the Credit denomination is effectively forbidden.** Prices are edited in the Rate card; 1 Credit = ¥0.01 is a fixed commitment across all history.

Source: grilling session 2026-10-30; upstream prices from [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/).
