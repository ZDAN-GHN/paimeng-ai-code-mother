-- V14 数据库约束治理的回滚脚本
--
-- Flyway 不提供 down 迁移，本脚本用于把已应用 V14 的库手工退回 V13 状态。
-- MySQL 的 DDL 是隐式提交的，V14 本身不是原子迁移；执行前必须确认已有备份。
-- 回滚会重新引入排序规则不一致与 fk_validation_queue_event 的父行加锁问题，
-- 因此只应作为故障恢复手段；如需长期修正请新建 V15 增量迁移。
--
-- 已验证：可在 V14 已应用的数据库上完整执行并把 schema 还原为 V13 形态。

DELETE FROM flyway_schema_history WHERE version = '14';

-- 1) 恢复排序规则到服务端默认（V14 之前这 5 张表没有显式声明字符集）
ALTER TABLE platform_application_lifecycle_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE platform_task_transition_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE platform_run_transition_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE platform_validation_queue
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE platform_validation_queue_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE platform_validation_queue
    MODIFY COLUMN runId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    MODIFY COLUMN attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL;
ALTER TABLE platform_validation_queue_event
    MODIFY COLUMN attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL;

-- 2) 恢复 app.appName 的可空定义
ALTER TABLE app MODIFY COLUMN appName VARCHAR(256) NULL COMMENT '应用名称';

-- 3) 恢复被删除的索引
CREATE INDEX idx_userId ON app (userId);
CREATE INDEX idx_appId ON chat_history (appId);

-- 4) 恢复被删除的外键
ALTER TABLE platform_validation_queue
    ADD CONSTRAINT fk_validation_queue_event FOREIGN KEY (eventId)
        REFERENCES platform_run_transition_event (id),
    ADD CONSTRAINT fk_validation_queue_run FOREIGN KEY (runId)
        REFERENCES platform_run (id);
ALTER TABLE platform_source_revision
    ADD CONSTRAINT fk_source_revision_engineering FOREIGN KEY (engineeringEvidenceId)
        REFERENCES platform_validation_evidence (id),
    ADD CONSTRAINT fk_source_revision_database FOREIGN KEY (databaseEvidenceId)
        REFERENCES platform_validation_evidence (id),
    ADD CONSTRAINT fk_source_revision_runtime FOREIGN KEY (runtimeEvidenceId)
        REFERENCES platform_validation_evidence (id),
    ADD CONSTRAINT fk_source_revision_task_acceptance FOREIGN KEY (taskAcceptanceEvidenceId)
        REFERENCES platform_validation_evidence (id);

-- 5) 恢复被删除的触发器
DELIMITER $$
CREATE TRIGGER platform_run_success_enqueue
AFTER INSERT ON platform_run_transition_event
FOR EACH ROW
BEGIN
    IF NEW.toState = 'SUCCEEDED' AND NEW.actorType = 'PLATFORM' THEN
        INSERT INTO platform_validation_queue (eventId, appId, runId)
        VALUES (NEW.id, NEW.appId, NEW.runId);
    END IF;
END$$

CREATE TRIGGER platform_validation_queue_audit_insert
AFTER INSERT ON platform_validation_queue
FOR EACH ROW
BEGIN
    INSERT INTO platform_validation_queue_event (eventId, runId, attemptId, toState)
    VALUES (NEW.eventId, NEW.runId, NEW.attemptId, NEW.state);
END$$

CREATE TRIGGER platform_validation_queue_audit_update
AFTER UPDATE ON platform_validation_queue
FOR EACH ROW
BEGIN
    IF NOT (NEW.state <=> OLD.state)
        OR NOT (NEW.attemptId <=> OLD.attemptId)
        OR NOT (NEW.leasedUntil <=> OLD.leasedUntil)
        OR NOT (NEW.resultCode <=> OLD.resultCode) THEN
        INSERT INTO platform_validation_queue_event
            (eventId, runId, attemptId, fromState, toState, reasonCode)
        VALUES (NEW.eventId, NEW.runId, NEW.attemptId, OLD.state, NEW.state, NEW.resultCode);
    END IF;
END$$
DELIMITER ;

-- 6) 删除 V14 新增的 CHECK
ALTER TABLE app
    DROP CHECK ck_app_is_delete,
    DROP CHECK ck_app_lifecycle;
ALTER TABLE chat_history
    DROP CHECK ck_chat_history_is_delete,
    DROP CHECK ck_chat_history_message_type;
ALTER TABLE platform_application_lifecycle_event
    DROP CHECK ck_application_lifecycle_request,
    DROP CHECK ck_application_lifecycle_event;
ALTER TABLE platform_candidate_source_snapshot
    DROP CHECK ck_candidate_snapshot_identity,
    DROP CHECK ck_candidate_snapshot_status;
ALTER TABLE platform_profile_disposition
    DROP CHECK ck_profile_disposition_hash;
ALTER TABLE platform_run
    DROP CHECK ck_platform_run_attempt,
    DROP CHECK ck_platform_run_state;
ALTER TABLE platform_run_command_request
    DROP CHECK ck_run_command_exit,
    DROP CHECK ck_run_command_fence,
    DROP CHECK ck_run_command_status;
ALTER TABLE platform_run_lease
    DROP CHECK ck_run_lease_fence,
    DROP CHECK ck_run_lease_renew;
ALTER TABLE platform_run_lease_event
    DROP CHECK ck_run_lease_event;
ALTER TABLE platform_run_recovery_checkpoint
    DROP CHECK ck_run_recovery_fence,
    DROP CHECK ck_run_recovery_phase;
ALTER TABLE platform_run_transition_event
    DROP CHECK ck_run_transition_actor,
    DROP CHECK ck_run_transition_state;
ALTER TABLE platform_source_revision
    DROP CHECK ck_source_revision_id;
ALTER TABLE platform_task
    DROP CHECK ck_platform_task_state;
ALTER TABLE platform_task_transition_event
    DROP CHECK ck_task_transition_actor,
    DROP CHECK ck_task_transition_state;
ALTER TABLE platform_trusted_profile_version
    DROP CHECK ck_profile_version;
ALTER TABLE platform_validation_evidence
    DROP CHECK ck_validation_evidence_hash;
ALTER TABLE platform_validation_queue_event
    DROP CHECK ck_validation_queue_event;
ALTER TABLE platform_validation_queue
    DROP CHECK ck_validation_queue_attempt,
    ADD CONSTRAINT ck_validation_queue_attempt CHECK (attemptNumber >= 0);
ALTER TABLE user
    DROP CHECK ck_user_is_delete,
    DROP CHECK ck_user_role;
