-- Credit 计费的费率表（docs/specs/credit-billing.md「Rate card」、docs/adr/0004-credit-billing.md）。
-- 只追加：同一 (provider_id, model_name) 可以在不同 effective_from 上有多个版本，改价只加行，不改历史行；
-- 结算按「步骤发生时刻」解析当时生效的版本，所以改价之后历史账单仍然解释得通。
-- 时间列与其它表一致，为 UTC 朴素时间戳（TIMESTAMP(3)）。
-- 用户售价（Credit / 1M tokens）与上游 USD 成本分开存：成本未知就留 NULL，不拿售价折算冒充真实成本。

CREATE TABLE credit_rate_card (
  provider_id VARCHAR(64) NOT NULL,
  model_name VARCHAR(256) NOT NULL,
  effective_from TIMESTAMP(3) NOT NULL,
  credit_input_miss INTEGER NOT NULL CHECK (credit_input_miss >= 0),
  credit_input_hit INTEGER NOT NULL CHECK (credit_input_hit >= 0),
  credit_output INTEGER NOT NULL CHECK (credit_output >= 0),
  usd_input_miss NUMERIC(12,6),
  usd_input_hit NUMERIC(12,6),
  usd_output NUMERIC(12,6),
  cost_basis VARCHAR(16) CHECK (cost_basis IN ('peak', 'off-peak', 'unknown')),
  cost_source VARCHAR(512),
  note TEXT,
  created_by BIGINT,
  create_time TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (provider_id, model_name, effective_from)
);
CREATE INDEX idx_credit_rate_card_model ON credit_rate_card (provider_id, model_name, effective_from DESC);

-- 初始费率：1 Credit = ¥0.01，定价基准是上游峰时价 × 3（谷时差价是毛利缓冲，不作定价依据）。
-- 生效时间写固定的过去时刻，不用 now()，这样迁移可重复执行且结果确定。
-- provider_id 取模型初始化的种子提供商 env-default（src/shared/model-config.ts 的 defaultModelProviderId）。
-- deepseek-v4-pro 的上游成本没有公开报价，usd_* 留 NULL、cost_basis 标 unknown，不编造数字。
INSERT INTO credit_rate_card
  (provider_id, model_name, effective_from, credit_input_miss, credit_input_hit, credit_output, usd_input_miss, usd_input_hit, usd_output, cost_basis, cost_source, note, created_by, create_time)
VALUES
  ('env-default', 'deepseek-flash', '2026-10-01 00:00:00.000', 600, 12, 2500, 0.300000, 0.006000, 1.200000, 'peak', 'https://api-docs.deepseek.com/quick_start/pricing', '按上游峰时价 × 3 定价', NULL, '2026-10-01 00:00:00.000'),
  ('env-default', 'deepseek-v4-pro', '2026-10-01 00:00:00.000', 2600, 50, 8500, NULL, NULL, NULL, 'unknown', NULL, '上游未公开报价，成本未知', NULL, '2026-10-01 00:00:00.000')
ON CONFLICT DO NOTHING;
