-- 提供商「API 格式」与两种密钥来源（环境变量引用 / 直接输入密文）。
-- 本文件不是幂等的：MySQL 的 DDL 会自动提交，若第 2 步之后失败，需要人工确认列状态后再重跑。
-- 第 1 步先校验旧值：未知的 apiFormat 会让迁移失败，不静默改写。
-- MySQL 不允许重命名仍被 CHECK 约束引用的列，所以校验通过后立刻删掉这个临时约束再改列名。
ALTER TABLE ts_model_provider ADD CONSTRAINT chk_model_provider_api_format_legacy CHECK (adapter IN ('openai-compatible', 'openai-chat', 'openai-responses', 'anthropic-messages'));
ALTER TABLE ts_model_provider DROP CHECK chk_model_provider_api_format_legacy;
ALTER TABLE ts_model_provider CHANGE COLUMN adapter apiFormat VARCHAR(64) NOT NULL;
UPDATE ts_model_provider SET apiFormat = 'openai-chat' WHERE apiFormat = 'openai-compatible';
ALTER TABLE ts_model_provider ADD CONSTRAINT chk_model_provider_api_format CHECK (apiFormat IN ('openai-chat', 'openai-responses', 'anthropic-messages'));
-- 密钥改为二选一：apiKeyEnv 引用环境变量，apiKeyCiphertext 存直接输入的密文（二选一由应用层校验）。
ALTER TABLE ts_model_provider MODIFY COLUMN apiKeyEnv VARCHAR(128) NULL;
ALTER TABLE ts_model_provider ADD COLUMN apiKeyCiphertext VARCHAR(2048) NULL;
