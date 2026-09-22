ALTER TABLE platform_application
    ADD COLUMN is_deleted TINYINT NOT NULL DEFAULT 0 COMMENT '逻辑删除标记；1 表示已归档' AFTER name,
    ADD COLUMN archived_at DATETIME NULL COMMENT '归档时间' AFTER updated_at,
    ADD COLUMN archived_by BIGINT NULL COMMENT '归档操作人' AFTER archived_at,
    ADD COLUMN archive_reason VARCHAR(256) NULL COMMENT '归档原因' AFTER archived_by,
    ADD INDEX idx_platform_application_owner_deleted (owner_id, is_deleted);

CREATE TABLE platform_application_lifecycle_event (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    actor_id BIGINT NOT NULL,
    reason_code VARCHAR(64) NULL,
    request_id VARCHAR(64) NOT NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_application_lifecycle_request (application_id, request_id),
    INDEX idx_platform_application_lifecycle_application_time (application_id, occurred_at)
) COMMENT='Append-only platform application lifecycle audit event';

CREATE TABLE platform_task_transition_event (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    task_id BIGINT NOT NULL,
    from_state VARCHAR(32) NOT NULL,
    to_state VARCHAR(32) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    reason_code VARCHAR(64) NULL,
    evidence_ref VARCHAR(128) NULL,
    request_id VARCHAR(64) NOT NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_task_transition_request (task_id, request_id),
    INDEX idx_platform_task_transition_task_time (task_id, occurred_at),
    INDEX idx_platform_task_transition_application_time (application_id, occurred_at)
) COMMENT='Append-only platform task state transition audit event';

CREATE TABLE platform_run_transition_event (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    from_state VARCHAR(32) NOT NULL,
    to_state VARCHAR(32) NOT NULL,
    actor_type VARCHAR(32) NOT NULL,
    reason_code VARCHAR(64) NULL,
    evidence_ref VARCHAR(128) NULL,
    request_id VARCHAR(64) NOT NULL,
    occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_run_transition_request (run_id, request_id),
    INDEX idx_platform_run_transition_run_time (run_id, occurred_at),
    INDEX idx_platform_run_transition_application_time (application_id, occurred_at)
) COMMENT='Append-only platform run state transition audit event';

CREATE TRIGGER platform_requirement_no_delete
BEFORE DELETE ON platform_requirement
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_requirement is retained evidence and cannot be deleted';

CREATE TRIGGER platform_trusted_profile_version_immutable
BEFORE UPDATE ON platform_trusted_profile_version
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_trusted_profile_version is immutable';

CREATE TRIGGER platform_trusted_profile_version_no_delete
BEFORE DELETE ON platform_trusted_profile_version
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_trusted_profile_version is retained evidence and cannot be deleted';

CREATE TRIGGER platform_task_no_delete
BEFORE DELETE ON platform_task
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_task is retained evidence and cannot be deleted';

CREATE TRIGGER platform_run_no_delete
BEFORE DELETE ON platform_run
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_run is retained evidence and cannot be deleted';

DELIMITER $$
CREATE TRIGGER platform_task_baseline_immutable
BEFORE UPDATE ON platform_task
FOR EACH ROW
BEGIN
    IF OLD.baseline_json IS NOT NULL AND (
        NOT (NEW.baseline_schema_version <=> OLD.baseline_schema_version)
        OR NOT (NEW.base_profile_version <=> OLD.base_profile_version)
        OR NOT (NEW.base_source_revision <=> OLD.base_source_revision)
        OR NOT (NEW.requested_outcome <=> OLD.requested_outcome)
        OR NOT (NEW.acceptance_target <=> OLD.acceptance_target)
        OR NOT (NEW.baseline_json <=> OLD.baseline_json)
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_task baseline is immutable after freezing';
    END IF;
END$$
DELIMITER ;
