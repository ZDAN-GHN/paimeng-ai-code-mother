-- A successful Run and its queue entry commit together. Pre-existing Run events are not re-enqueued.
CREATE TABLE platform_validation_queue (
    eventId BIGINT NOT NULL,
    appId BIGINT NOT NULL,
    runId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
    state VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    attemptNumber INT NOT NULL DEFAULT 0,
    leasedUntil DATETIME(3) NULL,
    resultCode VARCHAR(64) NULL,
    createdTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (eventId),
    UNIQUE KEY uk_validation_queue_run (runId),
    INDEX idx_validation_queue_claim (state, leasedUntil, eventId),
    CONSTRAINT fk_validation_queue_event FOREIGN KEY (eventId)
        REFERENCES platform_run_transition_event (id),
    CONSTRAINT fk_validation_queue_run FOREIGN KEY (runId)
        REFERENCES platform_run (id),
    CONSTRAINT ck_validation_queue_state CHECK (state IN
        ('PENDING', 'RUNNING', 'PASS', 'FAIL', 'INCONCLUSIVE', 'CLEANUP_FAILED')),
    CONSTRAINT ck_validation_queue_attempt CHECK (attemptNumber >= 0)
) COMMENT='Durable Platform-only candidate validation request';

CREATE TABLE platform_validation_queue_event (
    id BIGINT NOT NULL AUTO_INCREMENT,
    eventId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    fromState VARCHAR(24) NULL,
    toState VARCHAR(24) NOT NULL,
    reasonCode VARCHAR(64) NULL,
    occurredAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    INDEX idx_validation_queue_event_run (runId, id),
    CONSTRAINT fk_validation_queue_event_queue FOREIGN KEY (eventId)
        REFERENCES platform_validation_queue (eventId)
) COMMENT='Append-only validation queue transition audit';

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

CREATE TRIGGER platform_validation_queue_identity_guard
BEFORE UPDATE ON platform_validation_queue
FOR EACH ROW
BEGIN
    IF NOT (NEW.eventId <=> OLD.eventId)
        OR NOT (NEW.appId <=> OLD.appId)
        OR NOT (NEW.runId <=> OLD.runId)
        OR (OLD.state IN ('PASS', 'FAIL', 'INCONCLUSIVE', 'CLEANUP_FAILED')
            AND NOT (NEW.state <=> OLD.state))
        OR (OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'RUNNING'))
        OR (OLD.state = 'RUNNING' AND NEW.state NOT IN
            ('RUNNING', 'PASS', 'FAIL', 'INCONCLUSIVE', 'CLEANUP_FAILED'))
        OR (NEW.state <> 'PENDING' AND (NEW.attemptId IS NULL
            OR NEW.attemptId NOT REGEXP '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'))
        OR (OLD.state = 'RUNNING' AND OLD.leasedUntil > CURRENT_TIMESTAMP(3)
            AND NOT (NEW.attemptId <=> OLD.attemptId)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation queue identity or terminal state is immutable';
    END IF;
END$$

CREATE TRIGGER platform_validation_queue_no_delete
BEFORE DELETE ON platform_validation_queue
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation queue is retained evidence and cannot be deleted';
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

CREATE TRIGGER platform_validation_queue_event_no_update
BEFORE UPDATE ON platform_validation_queue_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation queue audit is immutable';
END$$

CREATE TRIGGER platform_validation_queue_event_no_delete
BEFORE DELETE ON platform_validation_queue_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'validation queue audit is retained and cannot be deleted';
END$$
DELIMITER ;
