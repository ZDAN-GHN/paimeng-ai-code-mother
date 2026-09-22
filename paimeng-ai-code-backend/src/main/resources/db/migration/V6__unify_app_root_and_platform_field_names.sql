ALTER TABLE app
    ADD COLUMN lifecycleStatus VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' COMMENT '应用生命周期状态' AFTER isDelete,
    ADD COLUMN archivedTime DATETIME NULL COMMENT '归档时间' AFTER lifecycleStatus,
    ADD COLUMN archivedBy BIGINT NULL COMMENT '归档操作人' AFTER archivedTime,
    ADD COLUMN archiveReason VARCHAR(256) NULL COMMENT '归档原因' AFTER archivedBy,
    ADD INDEX idx_app_userId_lifecycleStatus (userId, lifecycleStatus);

INSERT INTO app (
    id,
    appName,
    codeGenType,
    userId,
    editTime,
    createTime,
    updateTime,
    isDelete,
    lifecycleStatus,
    archivedTime,
    archivedBy,
    archiveReason
)
SELECT
    id,
    name,
    'html',
    owner_id,
    updated_at,
    created_at,
    updated_at,
    0,
    IF(is_deleted = 1, 'ARCHIVED', 'ACTIVE'),
    archived_at,
    archived_by,
    archive_reason
FROM platform_application;

DROP TRIGGER platform_task_baseline_immutable;

ALTER TABLE platform_requirement
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN parent_requirement_id TO parentRequirementId,
    RENAME COLUMN original_text TO originalText,
    RENAME COLUMN created_at TO createdTime;

ALTER TABLE platform_trusted_profile_version
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN version_number TO versionNumber,
    RENAME COLUMN profile_json TO profileJson,
    RENAME COLUMN created_at TO createdTime;

ALTER TABLE platform_task
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN requirement_id TO requirementId,
    RENAME COLUMN parent_task_id TO parentTaskId,
    RENAME COLUMN blocked_question TO blockedQuestion,
    RENAME COLUMN baseline_schema_version TO baselineSchemaVersion,
    RENAME COLUMN base_profile_version TO baseProfileVersion,
    RENAME COLUMN base_source_revision TO baseSourceRevision,
    RENAME COLUMN requested_outcome TO requestedOutcome,
    RENAME COLUMN acceptance_target TO acceptanceTarget,
    RENAME COLUMN baseline_json TO baselineJson,
    RENAME COLUMN failure_code TO failureCode,
    RENAME COLUMN created_at TO createdTime,
    RENAME COLUMN updated_at TO updatedTime;

ALTER TABLE platform_run
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN task_id TO taskId,
    RENAME COLUMN attempt_number TO attemptNumber,
    RENAME COLUMN started_at TO startedTime,
    RENAME COLUMN finished_at TO finishedTime,
    RENAME COLUMN created_at TO createdTime,
    RENAME COLUMN updated_at TO updatedTime;

ALTER TABLE platform_application_lifecycle_event
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN event_type TO eventType,
    RENAME COLUMN actor_type TO actorType,
    RENAME COLUMN actor_id TO actorId,
    RENAME COLUMN reason_code TO reasonCode,
    RENAME COLUMN request_id TO requestId,
    RENAME COLUMN occurred_at TO occurredTime;

ALTER TABLE platform_task_transition_event
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN task_id TO taskId,
    RENAME COLUMN from_state TO fromState,
    RENAME COLUMN to_state TO toState,
    RENAME COLUMN actor_type TO actorType,
    RENAME COLUMN reason_code TO reasonCode,
    RENAME COLUMN evidence_ref TO evidenceRef,
    RENAME COLUMN request_id TO requestId,
    RENAME COLUMN occurred_at TO occurredTime;

ALTER TABLE platform_run_transition_event
    RENAME COLUMN application_id TO appId,
    RENAME COLUMN run_id TO runId,
    RENAME COLUMN from_state TO fromState,
    RENAME COLUMN to_state TO toState,
    RENAME COLUMN actor_type TO actorType,
    RENAME COLUMN reason_code TO reasonCode,
    RENAME COLUMN evidence_ref TO evidenceRef,
    RENAME COLUMN request_id TO requestId,
    RENAME COLUMN occurred_at TO occurredTime;

DROP TABLE platform_application;

DELIMITER $$
CREATE TRIGGER platform_task_baseline_immutable
BEFORE UPDATE ON platform_task
FOR EACH ROW
BEGIN
    IF OLD.baselineJson IS NOT NULL AND (
        NOT (NEW.baselineSchemaVersion <=> OLD.baselineSchemaVersion)
        OR NOT (NEW.baseProfileVersion <=> OLD.baseProfileVersion)
        OR NOT (NEW.baseSourceRevision <=> OLD.baseSourceRevision)
        OR NOT (NEW.requestedOutcome <=> OLD.requestedOutcome)
        OR NOT (NEW.acceptanceTarget <=> OLD.acceptanceTarget)
        OR NOT (NEW.baselineJson <=> OLD.baselineJson)
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_task baseline is immutable after freezing';
    END IF;
END$$
DELIMITER ;
