CREATE TABLE IF NOT EXISTS ts_model_provider (
 id VARCHAR(64) NOT NULL PRIMARY KEY, displayName VARCHAR(128) NOT NULL, adapter VARCHAR(64) NOT NULL, baseUrl VARCHAR(2048) NOT NULL, apiKeyEnv VARCHAR(128) NOT NULL, options JSON NOT NULL, enabled TINYINT NOT NULL DEFAULT 0, createTime DATETIME(3) NOT NULL, updateTime DATETIME(3) NOT NULL
) COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ts_model_alias (
 alias VARCHAR(64) NOT NULL PRIMARY KEY, providerId VARCHAR(64) NOT NULL, modelName VARCHAR(256) NOT NULL, capabilities JSON NOT NULL, settings JSON NOT NULL, enabled TINYINT NOT NULL DEFAULT 0, createTime DATETIME(3) NOT NULL, updateTime DATETIME(3) NOT NULL, INDEX idx_model_alias_provider(providerId), CONSTRAINT fk_model_alias_provider FOREIGN KEY (providerId) REFERENCES ts_model_provider(id) ON DELETE RESTRICT ON UPDATE RESTRICT
) COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ts_model_config_state (
 id VARCHAR(32) NOT NULL PRIMARY KEY, revision BIGINT UNSIGNED NOT NULL DEFAULT 0, refreshEpoch BIGINT UNSIGNED NOT NULL DEFAULT 0, updateTime DATETIME(3) NOT NULL
) COLLATE=utf8mb4_unicode_ci;
INSERT INTO ts_model_config_state(id, revision, refreshEpoch, updateTime)
VALUES ('models', 0, 0, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE id = id;
