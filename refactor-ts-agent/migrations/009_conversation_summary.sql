-- 每个应用一条滚动摘要。两个覆盖游标各自只前进不后退（补迁旧历史与原生消息是两个 sequence 区块，
-- 不能互相比较），version 用于乐观并发。
-- summary 为 NULL 表示尚未成功摘要过；lastAttemptTime 记录失败尝试，用于重试节流。
CREATE TABLE IF NOT EXISTS ts_app_summary (
  appId BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  summary MEDIUMTEXT,
  coveredThroughSequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  legacyCoveredThroughSequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
  version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  modelAlias VARCHAR(64),
  providerId VARCHAR(64),
  modelName VARCHAR(256),
  inputTokens INT UNSIGNED,
  outputTokens INT UNSIGNED,
  lastAttemptTime DATETIME(3),
  createTime DATETIME(3) NOT NULL,
  updateTime DATETIME(3) NOT NULL
) COLLATE=utf8mb4_unicode_ci;
