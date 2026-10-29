-- harness 控制面（PLAN.md §1/§3/§4）：所有权、持久输入、隔离执行、源码快照、调用、提问、转移、交付与部署。
-- 本迁移只新增表和新列，不改既有表定义，也不回改已有迁移。
-- 时间列与其它表一致，为 UTC 朴素时间戳，到期判定一律用数据库时钟。

-- 每个应用一行永久 authority：epoch 单调递增，释放只清 holder，不删行。
CREATE TABLE app_authority (
  app_id BIGINT PRIMARY KEY REFERENCES app (id) ON DELETE CASCADE,
  owner_epoch BIGINT NOT NULL DEFAULT 0,
  holder TEXT,
  process_id TEXT,
  expires_at TIMESTAMP(3),
  state VARCHAR(16) NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'active', 'draining')),
  draft_snapshot_id VARCHAR(36),
  preview_delivery_id VARCHAR(36),
  preview_revision BIGINT NOT NULL DEFAULT 0,
  update_time TIMESTAMP(3) NOT NULL
);

-- 持久输入：接收即落库，一张表兼作待交付记录。requestId 幂等，seq 按 generation 连续。
CREATE TABLE generation_input (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36) NOT NULL REFERENCES generation (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  mode VARCHAR(16) NOT NULL CHECK (mode IN ('start', 'steer', 'followUp', 'write', 'answer')),
  message TEXT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('accepted', 'placed', 'resolved', 'withdrawn', 'unanswered')),
  sdk_submission_id BIGINT,
  sdk_entry_id VARCHAR(64),
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  UNIQUE (app_id, request_id),
  UNIQUE (generation_id, seq)
);

-- 隔离执行：一个 generation 一条，固定目录与 conversation。每 app 同时最多一条未收束执行。
CREATE TABLE generation_execution (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36) NOT NULL REFERENCES generation (id) ON DELETE CASCADE,
  conversation_id BIGINT,
  epoch BIGINT NOT NULL,
  directory TEXT NOT NULL,
  baseline_kind VARCHAR(16) NOT NULL,
  baseline_snapshot_id VARCHAR(36),
  baseline_version_sha CHAR(40),
  status VARCHAR(16) NOT NULL CHECK (status IN ('preparing', 'active', 'draining', 'sealed', 'failed')),
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  UNIQUE (generation_id)
);
CREATE UNIQUE INDEX uk_generation_execution_app_open ON generation_execution (app_id)
  WHERE status IN ('preparing', 'active', 'draining');

-- 源码快照：草稿封存、版本源码、模板初始化结果都用它登记（directory 为封存后的只读目录）。
CREATE TABLE source_snapshot (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36),
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('draft', 'version', 'template')),
  parent_version_sha CHAR(40),
  digest CHAR(64) NOT NULL,
  directory TEXT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('freezing', 'sealed', 'failed')),
  message TEXT,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_source_snapshot_app_time ON source_snapshot (app_id, create_time DESC);
CREATE INDEX idx_source_snapshot_generation ON source_snapshot (generation_id);

-- 实际副作用记录：prepared 只表示已登记，sent 表示可能已发出，unknown 不重发。
CREATE TABLE generation_attempt (
  id VARCHAR(36) PRIMARY KEY,
  execution_id VARCHAR(36) NOT NULL REFERENCES generation_execution (id) ON DELETE CASCADE,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('model', 'build')),
  operation_no INTEGER NOT NULL,
  request_summary JSONB,
  status VARCHAR(16) NOT NULL CHECK (status IN ('prepared', 'sent', 'succeeded', 'failed', 'unknown')),
  result JSONB,
  usage JSONB,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  UNIQUE (execution_id, kind, operation_no)
);

-- ask：一次只有一个开放提问。
CREATE TABLE harness_question (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36) NOT NULL REFERENCES generation (id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('open', 'answered', 'cancelled')),
  answer_input_id VARCHAR(36),
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX uk_harness_question_app_open ON harness_question (app_id)
  WHERE status = 'open';

-- 状态转移流水：诊断用，不设外键（历史必须活过 generation 的删除）。
CREATE TABLE generation_transition (
  id BIGSERIAL PRIMARY KEY,
  app_id BIGINT NOT NULL,
  generation_id VARCHAR(36) NOT NULL,
  from_state VARCHAR(16),
  to_state VARCHAR(16) NOT NULL,
  reason TEXT,
  create_time TIMESTAMP(3) NOT NULL
);
CREATE INDEX idx_generation_transition_generation ON generation_transition (generation_id, create_time);

-- 已验收交付：预览、下载、部署都从这里取内容，一个版本最多一条。
CREATE TABLE generation_delivery (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  generation_id VARCHAR(36),
  version_sha CHAR(40) NOT NULL,
  source_snapshot_id VARCHAR(36) NOT NULL,
  directory TEXT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('ready', 'superseded')),
  create_time TIMESTAMP(3) NOT NULL,
  UNIQUE (app_id, version_sha)
);

-- 预览指针：revision 单调递增，发布事务里与版本一起原子推进。
CREATE TABLE app_preview_pointer (
  app_id BIGINT PRIMARY KEY REFERENCES app (id) ON DELETE CASCADE,
  delivery_id VARCHAR(36),
  revision BIGINT NOT NULL DEFAULT 0,
  update_time TIMESTAMP(3) NOT NULL
);

-- 用户手动部署：requestId 幂等，每 app 同时最多一个运行中的部署。
CREATE TABLE app_deployment (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL REFERENCES app (id) ON DELETE CASCADE,
  version_sha CHAR(40) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('running', 'ready', 'failed')),
  deploy_key VARCHAR(64),
  error TEXT,
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  UNIQUE (app_id, request_id)
);
CREATE UNIQUE INDEX uk_app_deployment_app_running ON app_deployment (app_id)
  WHERE status = 'running';

-- 产品四相位与完成判定字段：公开状态仍是 generation.status，phase 只在内部控制面使用。
ALTER TABLE generation
  ADD COLUMN IF NOT EXISTS phase VARCHAR(16) NOT NULL DEFAULT 'editing' CHECK (phase IN ('editing', 'checking', 'publishing', 'finished')),
  ADD COLUMN IF NOT EXISTS deadline TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS input_watermark INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_version_sha CHAR(40);
