-- Credit 出账与分录（docs/specs/credit-billing.md「账本」、docs/adr/0004-credit-billing.md、04-settlement-design.md §3）。
-- 只新增表，不改既有表定义，也不回改已有迁移。
-- 时间列与其它表一致，为 UTC 朴素时间戳（TIMESTAMP(3)，应用层写 'YYYY-MM-DD HH:MM:SS.mmm'）。

-- 出账聚合根：一次 Generation 一行，generation_id 唯一就是「只结算一次」的实现。
-- credits / cost_usd / status 是由 credit_entry 推导的投影，每次追加分录后在同一事务里重写，
-- 不允许手工编辑；不可变字段是 generation_id / app_id / user_id / create_time / 两个快照。
-- 账本自带 app_id 与 user_id 副本且不建外键：删除应用会级联删 generation，账本行必须留下。
CREATE TABLE credit_charge (
  generation_id      VARCHAR(36) NOT NULL UNIQUE,
  app_id             BIGINT NOT NULL,
  user_id            BIGINT NOT NULL,
  credits            BIGINT NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(14,6),
  rate_card_snapshot JSONB NOT NULL,
  usage_snapshot     JSONB NOT NULL,
  status             VARCHAR(16) NOT NULL CHECK (status IN ('settled', 'estimated', 'partial', 'unpriced', 'reversed')),
  estimated_steps    INTEGER NOT NULL DEFAULT 0 CHECK (estimated_steps >= 0),
  create_time        TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_charge_credits_non_negative CHECK (credits >= 0)
);
CREATE INDEX idx_credit_charge_app_time ON credit_charge (app_id, create_time DESC);
CREATE INDEX idx_credit_charge_user_time ON credit_charge (user_id, create_time DESC);

-- 出账分录：一次 Charge 按池拆成多行。正数为扣减、负数为退还；冲正只追加反向行，绝不 UPDATE/DELETE。
-- charge_id 不建外键：账本只追加，不随父行删除。
CREATE TABLE credit_entry (
  id          BIGSERIAL PRIMARY KEY,
  charge_id   VARCHAR(36) NOT NULL,
  pool        VARCHAR(16) NOT NULL CHECK (pool IN ('quota', 'balance')),
  credits     BIGINT NOT NULL,
  reversal_of BIGINT,
  create_time TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_entry_non_zero CHECK (credits <> 0)
);
CREATE INDEX idx_credit_entry_charge ON credit_entry (charge_id, id);
