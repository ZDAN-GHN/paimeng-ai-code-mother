-- 版本台账（docs/plans/version-ledger.md）：Git 承载内容，这里只放清单要展示的产品字段。
-- 与 004 的 app_version 不是同一张表：那张表冻结为历史迁移的只读数据源，永不改写也不删除。
-- 时间列与其它表一致，为 UTC 朴素时间戳。

CREATE TABLE version_record (
  commit_sha CHAR(40) NOT NULL,
  app_id BIGINT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  generation_id VARCHAR(36) REFERENCES generation(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  create_time TIMESTAMP(3) NOT NULL,
  -- 提交只在各自仓库里唯一：两个应用可能在同一秒提交出完全相同的 SHA，主键必须带上应用。
  PRIMARY KEY (app_id, commit_sha)
);

CREATE INDEX idx_version_record_app_time ON version_record (app_id, create_time DESC);

-- 一轮生成最多一版：收尾重放时靠它天然幂等，不必先查后写。
CREATE UNIQUE INDEX uk_version_record_generation ON version_record (generation_id)
  WHERE generation_id IS NOT NULL;
