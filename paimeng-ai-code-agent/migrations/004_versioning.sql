-- 应用版本化（docs/plans/versioning.md）：git 裸库承载内容，这里只放元数据。
-- 历史只增不减：回退/采纳都在当前分支新增一版，不删除既有记录。
-- 时间列与其它表一致，为 UTC 朴素时间戳。

CREATE TABLE app_version (
  id VARCHAR(36) PRIMARY KEY,
  app_id BIGINT NOT NULL,
  branch VARCHAR(64) NOT NULL DEFAULT 'main',
  seq INTEGER NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  source_version_id VARCHAR(36),
  title VARCHAR(200) NOT NULL,
  prompt TEXT,
  changed_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  thumbnail_key VARCHAR(512),
  generation_id VARCHAR(36),
  create_time TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX uk_app_version_commit ON app_version (app_id, commit_sha);
CREATE UNIQUE INDEX uk_app_version_seq ON app_version (app_id, branch, seq);
CREATE INDEX idx_app_version_app ON app_version (app_id, create_time);

CREATE TABLE app_version_state (
  app_id BIGINT PRIMARY KEY,
  branch VARCHAR(64) NOT NULL DEFAULT 'main',
  head_version_id VARCHAR(36),
  version_seq INTEGER NOT NULL DEFAULT 0,
  update_time TIMESTAMP(3) NOT NULL
);

CREATE TABLE app_version_branch (
  app_id BIGINT NOT NULL,
  branch VARCHAR(64) NOT NULL,
  base_version_id VARCHAR(36),
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  create_time TIMESTAMP(3) NOT NULL,
  update_time TIMESTAMP(3) NOT NULL,
  PRIMARY KEY (app_id, branch)
);
