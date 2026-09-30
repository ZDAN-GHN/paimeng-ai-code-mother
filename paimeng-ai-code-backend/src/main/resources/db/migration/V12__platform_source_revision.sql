-- Existing applications have no authoritative revision until a validated promotion occurs.
ALTER TABLE app
    ADD COLUMN stableSourceRevision VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL;

-- Existing evidence remains readable but cannot be promoted as a validator-issued result.
ALTER TABLE platform_validation_evidence
    ADD COLUMN issuer VARCHAR(32) NOT NULL DEFAULT 'LEGACY',
    ADD COLUMN attemptId VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'LEGACY',
    ADD CONSTRAINT ck_validation_issuer CHECK (
        (HEX(issuer) = HEX('LEGACY') AND HEX(attemptId) = HEX('LEGACY')) OR
        (HEX(issuer) = HEX('PLATFORM_VALIDATOR_V1') AND
         attemptId REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    );

ALTER TABLE platform_task
    ADD UNIQUE KEY uk_task_owner (id, appId);
ALTER TABLE platform_run
    ADD UNIQUE KEY uk_run_owner_task (id, appId, taskId);
ALTER TABLE platform_trusted_profile_version
    ADD UNIQUE KEY uk_profile_owner (id, appId);

CREATE TABLE platform_source_revision (
    id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    baselineHash CHAR(64) NOT NULL,
    baseSourceRevision VARCHAR(128) NULL,
    commitHash CHAR(40) NOT NULL,
    treeHash CHAR(40) NOT NULL,
    profileVersionId BIGINT NOT NULL,
    engineeringEvidenceId BIGINT NOT NULL,
    databaseEvidenceId BIGINT NOT NULL,
    runtimeEvidenceId BIGINT NOT NULL,
    taskAcceptanceEvidenceId BIGINT NOT NULL,
    validationAttemptId VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_source_revision_owner (id, appId),
    UNIQUE KEY uk_source_revision_run (runId),
    UNIQUE KEY uk_source_revision_task (taskId),
    CONSTRAINT fk_source_revision_app FOREIGN KEY (appId) REFERENCES app (id),
    CONSTRAINT fk_source_revision_task FOREIGN KEY (taskId, appId) REFERENCES platform_task (id, appId),
    CONSTRAINT fk_source_revision_run FOREIGN KEY (runId, appId, taskId)
        REFERENCES platform_run (id, appId, taskId),
    CONSTRAINT fk_source_revision_snapshot FOREIGN KEY (runId, appId, taskId, baselineHash, commitHash, treeHash)
        REFERENCES platform_candidate_source_snapshot (runId, appId, taskId, baselineHash, commitHash, treeHash),
    CONSTRAINT fk_source_revision_profile FOREIGN KEY (profileVersionId, appId)
        REFERENCES platform_trusted_profile_version (id, appId),
    CONSTRAINT fk_source_revision_engineering FOREIGN KEY (engineeringEvidenceId)
        REFERENCES platform_validation_evidence (id),
    CONSTRAINT fk_source_revision_database FOREIGN KEY (databaseEvidenceId)
        REFERENCES platform_validation_evidence (id),
    CONSTRAINT fk_source_revision_runtime FOREIGN KEY (runtimeEvidenceId)
        REFERENCES platform_validation_evidence (id),
    CONSTRAINT fk_source_revision_task_acceptance FOREIGN KEY (taskAcceptanceEvidenceId)
        REFERENCES platform_validation_evidence (id),
    CONSTRAINT ck_source_revision_identity CHECK (
        CHAR_LENGTH(TRIM(id)) > 0 AND baselineHash REGEXP '^[0-9a-f]{64}$'
        AND validationAttemptId REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND commitHash REGEXP '^[0-9a-f]{40}$' AND treeHash REGEXP '^[0-9a-f]{40}$'
        AND engineeringEvidenceId <> databaseEvidenceId
        AND engineeringEvidenceId <> runtimeEvidenceId
        AND engineeringEvidenceId <> taskAcceptanceEvidenceId
        AND databaseEvidenceId <> runtimeEvidenceId
        AND databaseEvidenceId <> taskAcceptanceEvidenceId
        AND runtimeEvidenceId <> taskAcceptanceEvidenceId
    )
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE app
    ADD CONSTRAINT fk_app_stable_revision FOREIGN KEY (stableSourceRevision, id)
        REFERENCES platform_source_revision (id, appId);

DELIMITER $$
CREATE TRIGGER source_revision_insert_guard
BEFORE INSERT ON platform_source_revision FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM platform_task
        WHERE id = NEW.taskId AND appId = NEW.appId AND HEX(state) = HEX('VALIDATED')
          AND baselineJson IS NOT NULL AND HEX(SHA2(baselineJson, 256)) = HEX(NEW.baselineHash)
          AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision))
        OR NOT EXISTS (SELECT 1 FROM platform_run
            WHERE HEX(id) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(state) = HEX('SUCCEEDED'))
        OR NOT EXISTS (SELECT 1 FROM platform_candidate_source_snapshot
            WHERE HEX(runId) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(status) = HEX('READY'))
        OR NOT EXISTS (SELECT 1 FROM platform_profile_disposition
            WHERE HEX(runId) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(disposition) IN (HEX('changed'), HEX('unchanged')))
        OR NOT EXISTS (SELECT 1 FROM platform_profile_disposition d
            JOIN platform_task t ON t.id = NEW.taskId AND t.appId = NEW.appId
            WHERE HEX(d.runId) = HEX(NEW.runId) AND d.appId = NEW.appId
              AND (HEX(d.disposition) = HEX('changed')
                   OR (HEX(d.disposition) = HEX('unchanged') AND t.baseProfileVersion = NEW.profileVersionId)))
        OR NOT EXISTS (SELECT 1 FROM platform_validation_evidence
            WHERE id = NEW.engineeringEvidenceId AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(issuer) = HEX('PLATFORM_VALIDATOR_V1') AND HEX(attemptId) = HEX(NEW.validationAttemptId)
              AND HEX(runId) = HEX(NEW.runId) AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(category) = HEX('ENGINEERING') AND HEX(result) = HEX('PASS'))
        OR NOT EXISTS (SELECT 1 FROM platform_validation_evidence
            WHERE id = NEW.databaseEvidenceId AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(issuer) = HEX('PLATFORM_VALIDATOR_V1') AND HEX(attemptId) = HEX(NEW.validationAttemptId)
              AND HEX(runId) = HEX(NEW.runId) AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(category) = HEX('DATABASE') AND HEX(result) = HEX('PASS'))
        OR NOT EXISTS (SELECT 1 FROM platform_validation_evidence
            WHERE id = NEW.runtimeEvidenceId AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(issuer) = HEX('PLATFORM_VALIDATOR_V1') AND HEX(attemptId) = HEX(NEW.validationAttemptId)
              AND HEX(runId) = HEX(NEW.runId) AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(category) = HEX('RUNTIME') AND HEX(result) = HEX('PASS'))
        OR NOT EXISTS (SELECT 1 FROM platform_validation_evidence
            WHERE id = NEW.taskAcceptanceEvidenceId AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(issuer) = HEX('PLATFORM_VALIDATOR_V1') AND HEX(attemptId) = HEX(NEW.validationAttemptId)
              AND HEX(runId) = HEX(NEW.runId) AND HEX(baselineHash) = HEX(NEW.baselineHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND HEX(commitHash) = HEX(NEW.commitHash) AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(category) = HEX('TASK_ACCEPTANCE') AND HEX(result) = HEX('PASS'))
    THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'source revision requires matching validated evidence';
    END IF;
END$$
CREATE TRIGGER source_revision_immutable
BEFORE UPDATE ON platform_source_revision FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'source revision is immutable';
END$$
CREATE TRIGGER source_revision_no_delete
BEFORE DELETE ON platform_source_revision FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'source revision cannot be deleted';
END$$
DELIMITER ;
