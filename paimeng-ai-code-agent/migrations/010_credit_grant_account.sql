-- Credit 入账与余额快照（docs/specs/credit-billing.md「账本」、docs/adr/0004-credit-billing.md）。
-- 只新增表，不改既有表定义，也不回改已有迁移。
-- 时间列与其它表一致，为 UTC 朴素时间戳（TIMESTAMP(3)，应用层写 'YYYY-MM-DD HH:MM:SS.mmm'）。

-- Credit 进入系统的唯一入口：余额、可用额度、透支基数三个数全部从它推导，
-- 所以必须分得清 purchase（算透支基数）与 admin_grant（不算）。
CREATE TABLE credit_grant (
  id           VARCHAR(36) PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  pool         VARCHAR(16) NOT NULL CHECK (pool IN ('quota', 'balance')),
  credits      BIGINT NOT NULL,
  source       VARCHAR(16) NOT NULL CHECK (source IN ('purchase', 'admin_grant', 'monthly_quota')),
  external_ref VARCHAR(128),
  request_id   VARCHAR(128),
  granted_by   BIGINT,
  period       VARCHAR(7),
  note         TEXT,
  create_time  TIMESTAMP(3) NOT NULL,
  CONSTRAINT credit_grant_positive CHECK (credits > 0),
  CONSTRAINT credit_grant_pool_of_source CHECK ((source = 'monthly_quota') = (pool = 'quota')),
  CONSTRAINT credit_grant_period_required CHECK (source <> 'monthly_quota' OR period IS NOT NULL)
);
-- 客户端每次提交复用同一个 requestId：双击与超时重试不会重复入账。
CREATE UNIQUE INDEX uk_credit_grant_request ON credit_grant (user_id, request_id) WHERE request_id IS NOT NULL;
-- 将来的支付回调按支付单号幂等，不需要改表。
CREATE UNIQUE INDEX uk_credit_grant_external ON credit_grant (source, external_ref) WHERE external_ref IS NOT NULL;
-- 月度配额按 (user, period) 幂等，重跑安全。
CREATE UNIQUE INDEX uk_credit_grant_monthly ON credit_grant (user_id, period) WHERE source = 'monthly_quota';
CREATE INDEX idx_credit_grant_user_time ON credit_grant (user_id, create_time DESC);

-- 余额快照：每用户每池一行。它是写入原子性的载体，不是真相来源——任何时候都能由
-- credit_grant 减 credit_entry 重算，所以对账时它是对账对象。只有 balance 池可以为负。
CREATE TABLE credit_account (
  user_id     BIGINT NOT NULL,
  pool        VARCHAR(16) NOT NULL CHECK (pool IN ('quota', 'balance')),
  balance     BIGINT NOT NULL DEFAULT 0,
  update_time TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (user_id, pool),
  CONSTRAINT credit_account_quota_non_negative CHECK (pool <> 'quota' OR balance >= 0)
);
