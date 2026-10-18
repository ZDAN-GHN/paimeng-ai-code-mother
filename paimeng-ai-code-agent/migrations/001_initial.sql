-- 产品库（Postgres）初始结构：表名按业务域命名，列名 snake_case。
-- 对话转录不在这里——它由常驻 pi-durable harness 写进它的存储表（entries / tasks / …）。
-- 时间列一律是 UTC 朴素时间戳（timestamp without time zone），应用层按 'YYYY-MM-DD HH:MM:SS.mmm' 读写。

CREATE TABLE app_user (
  id BIGINT PRIMARY KEY,
  user_account VARCHAR(256) NOT NULL,
  user_password VARCHAR(512) NOT NULL,
  user_name VARCHAR(256),
  user_avatar VARCHAR(1024),
  user_profile VARCHAR(512),
  user_role VARCHAR(256) NOT NULL DEFAULT 'user',
  create_time TIMESTAMP NOT NULL,
  update_time TIMESTAMP NOT NULL,
  is_delete INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_app_user_account ON app_user (user_account);

CREATE TABLE app (
  id BIGINT PRIMARY KEY,
  app_name VARCHAR(256),
  cover VARCHAR(512),
  init_prompt TEXT NOT NULL,
  code_gen_type VARCHAR(64) NOT NULL,
  deploy_key VARCHAR(64),
  deployed_time TIMESTAMP,
  edit_time TIMESTAMP(3),
  priority INTEGER NOT NULL DEFAULT 0,
  user_id BIGINT NOT NULL,
  conversation_id BIGINT,
  create_time TIMESTAMP NOT NULL,
  update_time TIMESTAMP NOT NULL,
  is_delete INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uk_app_deploy_key ON app (deploy_key);
CREATE INDEX idx_app_user ON app (user_id);

CREATE TABLE user_session (
  token_hash VARCHAR(64) PRIMARY KEY,
  user_id BIGINT NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_user_session_expiry ON user_session (expires_at);

-- 应用雪花 ID 的发号状态（与 pi-durable 自己的 mintId 是两个命名空间）。
CREATE TABLE id_sequence (
  node_id SMALLINT PRIMARY KEY,
  last_id BIGINT NOT NULL
);
INSERT INTO id_sequence (node_id, last_id) VALUES (0, 0);

CREATE TABLE generation (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL,
  error TEXT,
  stop_reason VARCHAR(32),
  message_id VARCHAR(64),
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_generation_app ON generation (app_id, create_time);

-- 生成任务的逐步记账（D2）：kind 为 model / summary / build。token 为 NULL 表示上游未返回用量。
CREATE TABLE generation_step (
  id BIGSERIAL PRIMARY KEY,
  generation_id VARCHAR(36) NOT NULL REFERENCES generation (id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL,
  round INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  model_alias VARCHAR(64),
  provider_id VARCHAR(64),
  model_name VARCHAR(256),
  upstream_provider VARCHAR(64),
  upstream_model_id VARCHAR(256),
  duration_ms INTEGER,
  model_ms INTEGER,
  tool_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  finish_reason VARCHAR(32),
  status VARCHAR(16) NOT NULL,
  stage VARCHAR(32),
  repairable INTEGER,
  tool_calls JSONB,
  detail TEXT,
  create_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_generation_step_generation ON generation_step (generation_id);

-- 单应用单活跃生成（30 秒租约 + 5 秒心跳）。
CREATE TABLE generation_lease (
  app_id BIGINT PRIMARY KEY,
  generation_id VARCHAR(36) NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL
);

CREATE TABLE rate_limit (
  limit_key VARCHAR(191) PRIMARY KEY,
  window_start TIMESTAMP(3) NOT NULL,
  hits INTEGER NOT NULL
);

CREATE TABLE attachment (
  id VARCHAR(36) PRIMARY KEY,
  owner_user_id BIGINT NOT NULL,
  app_id BIGINT,
  original_name VARCHAR(256) NOT NULL,
  media_type VARCHAR(32) NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  hash CHAR(64) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  preview_key VARCHAR(512) NOT NULL,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_attachment_owner ON attachment (owner_user_id);
CREATE INDEX idx_attachment_app ON attachment (app_id);

CREATE TABLE model_provider (
  id VARCHAR(64) PRIMARY KEY,
  display_name VARCHAR(128) NOT NULL,
  api_format VARCHAR(64) NOT NULL,
  base_url VARCHAR(2048) NOT NULL,
  api_key_env VARCHAR(128),
  api_key_ciphertext VARCHAR(2048),
  options JSONB NOT NULL,
  headers JSONB,
  enabled INTEGER NOT NULL DEFAULT 0,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);

CREATE TABLE model_alias (
  alias VARCHAR(64) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL REFERENCES model_provider (id),
  model_name VARCHAR(256) NOT NULL,
  capabilities JSONB NOT NULL,
  settings JSONB NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_model_alias_provider ON model_alias (provider_id);

CREATE TABLE model_config_state (
  id VARCHAR(32) PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT 0,
  refresh_epoch BIGINT NOT NULL DEFAULT 0,
  update_time TIMESTAMP(3) NOT NULL
);
INSERT INTO model_config_state (id, revision, refresh_epoch, update_time) VALUES ('models', 0, 0, timezone('UTC', now()));
