-- 冲正审计（docs/specs/credit-billing.md「冲正」、04-settlement-design.md §4）。
-- 90 的自动冲正（平台故障）与 92 的 Admin 冲正都只在 credit_entry 上追加反向行，
-- 需要能说清「为什么退、谁操作的」：两列都可空，历史行与原扣费事实保持不变。
-- 只加列，不改既有列，也不回改已有迁移。
ALTER TABLE credit_entry ADD COLUMN reason VARCHAR(256);
ALTER TABLE credit_entry ADD COLUMN operator_id BIGINT;
