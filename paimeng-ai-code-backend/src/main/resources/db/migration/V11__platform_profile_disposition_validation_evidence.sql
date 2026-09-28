-- Bind every persisted row to the exact READY Git identity; READY rows cannot later drift.
ALTER TABLE platform_candidate_source_snapshot
    ADD UNIQUE KEY uk_candidate_snapshot_identity (runId, appId, taskId, baselineHash, commitHash, treeHash);

ALTER TABLE platform_requirement
    ADD UNIQUE KEY uk_requirement_owner_identity (id, appId);

CREATE TABLE platform_profile_disposition (
    runId VARCHAR(64) NOT NULL,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    baselineHash CHAR(64) NOT NULL,
    baseSourceRevision VARCHAR(128) NULL,
    commitHash CHAR(40) NOT NULL,
    treeHash CHAR(40) NOT NULL,
    disposition VARCHAR(16) NOT NULL,
    diffJson LONGTEXT NULL,
    requirementId BIGINT NULL,
    reason VARCHAR(2048) NOT NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (runId),
    CONSTRAINT fk_profile_snapshot FOREIGN KEY (runId, appId, taskId, baselineHash, commitHash, treeHash)
        REFERENCES platform_candidate_source_snapshot (runId, appId, taskId, baselineHash, commitHash, treeHash),
    CONSTRAINT fk_profile_requirement FOREIGN KEY (requirementId, appId)
        REFERENCES platform_requirement (id, appId),
    CONSTRAINT ck_profile_disposition CHECK (
        CHAR_LENGTH(TRIM(reason)) > 0 AND
        ((HEX(disposition) = HEX('changed') AND requirementId IS NOT NULL AND diffJson IS NOT NULL
            AND JSON_VALID(diffJson) AND JSON_TYPE(diffJson) IN ('OBJECT', 'ARRAY')
            AND JSON_LENGTH(diffJson) > 0 AND OCTET_LENGTH(diffJson) <= 65536)
         OR (HEX(disposition) IN (HEX('unchanged'), HEX('uncertain'))
             AND requirementId IS NULL AND diffJson IS NULL))
    )
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_validation_evidence (
    id BIGINT NOT NULL,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    baselineHash CHAR(64) NOT NULL,
    baseSourceRevision VARCHAR(128) NULL,
    commitHash CHAR(40) NOT NULL,
    treeHash CHAR(40) NOT NULL,
    category VARCHAR(64) NOT NULL,
    result VARCHAR(16) NOT NULL,
    payloadJson LONGTEXT NOT NULL,
    payloadSha256 CHAR(64) NOT NULL,
    artifactRef VARCHAR(78) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    artifactCommitHash CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    artifactSha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    idempotencyKey VARCHAR(64) NOT NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_validation_replay (runId, idempotencyKey),
    CONSTRAINT fk_validation_profile FOREIGN KEY (runId) REFERENCES platform_profile_disposition (runId),
    CONSTRAINT fk_validation_snapshot FOREIGN KEY (runId, appId, taskId, baselineHash, commitHash, treeHash)
        REFERENCES platform_candidate_source_snapshot (runId, appId, taskId, baselineHash, commitHash, treeHash),
    CONSTRAINT ck_validation_evidence CHECK (
        category REGEXP '^[A-Z][A-Z0-9_]*$' AND
        HEX(result) IN (HEX('PASS'), HEX('FAIL'), HEX('INCONCLUSIVE')) AND
        CHAR_LENGTH(TRIM(idempotencyKey)) > 0 AND
        payloadSha256 REGEXP '^[0-9a-f]{64}$' AND payloadSha256 = SHA2(payloadJson, 256) AND
        artifactRef REGEXP '^refs/evidence/[0-9a-f]{64}$' AND
        artifactCommitHash REGEXP '^[0-9a-f]{40}$' AND
        artifactSha256 REGEXP '^[0-9a-f]{64}$' AND
        JSON_VALID(payloadJson) AND JSON_TYPE(payloadJson) IN ('OBJECT', 'ARRAY')
        AND JSON_LENGTH(payloadJson) > 0 AND OCTET_LENGTH(payloadJson) <= 65536
    )
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$
CREATE TRIGGER candidate_snapshot_ready_immutable
BEFORE UPDATE ON platform_candidate_source_snapshot FOR EACH ROW
BEGIN
    IF OLD.status = 'READY' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'READY snapshot is immutable';
    END IF;
END$$
CREATE TRIGGER candidate_snapshot_ready_no_delete
BEFORE DELETE ON platform_candidate_source_snapshot FOR EACH ROW
BEGIN
    IF OLD.status = 'READY' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'READY snapshot cannot be deleted';
    END IF;
END$$
CREATE TRIGGER profile_disposition_insert_guard
BEFORE INSERT ON platform_profile_disposition FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM platform_candidate_source_snapshot
        WHERE HEX(runId) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
          AND HEX(baselineHash) = HEX(NEW.baselineHash) AND HEX(commitHash) = HEX(NEW.commitHash)
          AND HEX(treeHash) = HEX(NEW.treeHash) AND HEX(status) = HEX('READY')
          AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'profile disposition requires READY snapshot';
    END IF;
END$$
CREATE TRIGGER profile_disposition_immutable
BEFORE UPDATE ON platform_profile_disposition FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'profile disposition is immutable';
END$$
CREATE TRIGGER profile_disposition_no_delete
BEFORE DELETE ON platform_profile_disposition FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'profile disposition cannot be deleted';
END$$
CREATE TRIGGER validation_evidence_insert_guard
BEFORE INSERT ON platform_validation_evidence FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM platform_run
        WHERE HEX(id) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
          AND HEX(state) = HEX('SUCCEEDED'))
        OR NOT EXISTS (SELECT 1 FROM platform_candidate_source_snapshot
            WHERE HEX(runId) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(baselineHash) = HEX(NEW.baselineHash) AND HEX(commitHash) = HEX(NEW.commitHash)
              AND HEX(treeHash) = HEX(NEW.treeHash) AND HEX(status) = HEX('READY')
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision))
        OR NOT EXISTS (SELECT 1 FROM platform_profile_disposition
            WHERE HEX(runId) = HEX(NEW.runId) AND appId = NEW.appId AND taskId = NEW.taskId
              AND HEX(baselineHash) = HEX(NEW.baselineHash) AND HEX(commitHash) = HEX(NEW.commitHash)
              AND HEX(treeHash) = HEX(NEW.treeHash)
              AND HEX(baseSourceRevision) <=> HEX(NEW.baseSourceRevision)
              AND (HEX(NEW.result) <> HEX('PASS') OR HEX(disposition) <> HEX('uncertain'))) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation requires successful Run and eligible profile disposition';
    END IF;
END$$
CREATE TRIGGER validation_evidence_immutable
BEFORE UPDATE ON platform_validation_evidence FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation evidence is immutable';
END$$
CREATE TRIGGER validation_evidence_no_delete
BEFORE DELETE ON platform_validation_evidence FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation evidence cannot be deleted';
END$$
DELIMITER ;
