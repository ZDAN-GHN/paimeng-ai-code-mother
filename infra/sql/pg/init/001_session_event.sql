-- session_event：TS Agent 会话事件日志（append-only，唯一持久真相）
-- 记忆归 PG；纠正通过追加新事件完成，不做就地更新或软删除。
CREATE TABLE IF NOT EXISTS session_event
(
    id         BIGSERIAL   PRIMARY KEY,
    app_id     BIGINT      NOT NULL,
    user_id    BIGINT      NOT NULL,
    run_id     VARCHAR(64),
    seq        BIGINT      NOT NULL,
    turn_id    VARCHAR(64) NOT NULL,
    batch_seq  INTEGER     NOT NULL,
    event_index INTEGER     NOT NULL,
    kind       VARCHAR(64) NOT NULL,
    version    INTEGER     NOT NULL DEFAULT 1,
    ignorable  BOOLEAN     NOT NULL DEFAULT FALSE,
    source     VARCHAR(16) NOT NULL,
    payload    JSONB       NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uk_app_seq UNIQUE (app_id, seq),
    CONSTRAINT uk_app_turn_batch_event UNIQUE (app_id, turn_id, batch_seq, event_index),
    CONSTRAINT ck_batch_event_index CHECK (event_index >= 0),
    CONSTRAINT ck_source CHECK (source IN ('human', 'model', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_session_event_run_id
    ON session_event (run_id);

CREATE INDEX IF NOT EXISTS idx_session_event_app_created
    ON session_event (app_id, created_at);

-- 本脚本只负责新建或初始化空的本地开发数据卷。
-- 已按旧版 DDL 创建的本地表，应在无需保留测试数据时重建本地 PG 数据卷，
-- 或手工执行等价 ALTER/DROP CONSTRAINT 并补 event_index；生产迁移不在本票范围内。
