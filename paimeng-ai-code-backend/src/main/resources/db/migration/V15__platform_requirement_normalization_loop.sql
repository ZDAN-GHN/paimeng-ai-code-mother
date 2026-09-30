-- Requirement 到受控 Run 的执行闭环（Issue #80 / T-08）。
-- 归一化队列把「等 Agent 归一化」变成 Platform 自己的持久事实，而不是内存里的等待；
-- 进度事件只追加 Owner 安全的粗粒度阶段，不落 Agent 工具名、Pi Session 或 Sandbox 细节。
CREATE TABLE platform_normalization_queue (
    id BIGINT NOT NULL AUTO_INCREMENT,
    appId BIGINT NOT NULL,
    requirementId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    state VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    attemptNumber INT NOT NULL DEFAULT 0,
    leasedUntil DATETIME(3) NULL,
    resultCode VARCHAR(64) NULL,
    createdTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_normalization_queue_requirement (requirementId),
    INDEX idx_normalization_queue_claim (state, id),
    INDEX idx_normalization_queue_task (taskId),
    -- 沿用 V14 的 HEX() 大小写敏感比较：列是 ci collation，朴素比较会让 'ready' 通过值域约束。
    CONSTRAINT ck_normalization_queue_state CHECK (HEX(state) IN
        (HEX('PENDING'), HEX('RUNNING'), HEX('READY'), HEX('BLOCKED'), HEX('FAILED'))),
    CONSTRAINT ck_normalization_queue_attempt CHECK (attemptNumber >= 0)
) COMMENT='Durable Platform-only requirement normalization request';

CREATE TABLE platform_normalization_queue_event (
    id BIGINT NOT NULL AUTO_INCREMENT,
    queueId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    attemptId VARCHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    fromState VARCHAR(24) NULL,
    toState VARCHAR(24) NOT NULL,
    reasonCode VARCHAR(64) NULL,
    occurredTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    INDEX idx_normalization_queue_event_queue (queueId, id)
) COMMENT='Append-only normalization queue transition audit';

-- 进度阶段是 Owner 可见投影的一部分，因此只允许追加，且不允许未知阶段。
CREATE TABLE platform_run_progress_event (
    id BIGINT NOT NULL AUTO_INCREMENT,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    runId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    stage VARCHAR(32) NOT NULL,
    note VARCHAR(255) NULL,
    occurredTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    INDEX idx_run_progress_app (appId, id),
    CONSTRAINT ck_run_progress_stage CHECK (HEX(stage) IN
        (HEX('NORMALIZING'), HEX('NORMALIZATION_BLOCKED'), HEX('EXECUTING'),
         HEX('VALIDATING'), HEX('VALIDATION_FAILED')))
) COMMENT='Append-only owner-safe execution progress stage';

-- 答复是新的不可变 Requirement 行，指向被答复的原 Requirement。
-- OWNER 是 #74 之前的历史取值：platform_requirement 由触发器禁止 UPDATE，无法就地归一，
-- 因此值域必须显式容纳它，否则迁移会因既有行而失败。写入侧只会产生后两种。
ALTER TABLE platform_requirement
    ADD CONSTRAINT ck_requirement_kind CHECK (HEX(kind) IN
        (HEX('OWNER'), HEX('OWNER_REQUEST'), HEX('CLARIFICATION_ANSWER'))),
    DROP INDEX idx_platform_requirement_parent_id,
    ADD INDEX idx_requirement_parent (appId, parentRequirementId);

DELIMITER $$
CREATE TRIGGER platform_normalization_queue_identity_guard
BEFORE UPDATE ON platform_normalization_queue
FOR EACH ROW
BEGIN
    IF NOT (NEW.appId <=> OLD.appId)
        OR NOT (NEW.requirementId <=> OLD.requirementId)
        OR NOT (NEW.taskId <=> OLD.taskId)
        OR (OLD.state IN ('READY', 'BLOCKED', 'FAILED') AND NOT (NEW.state <=> OLD.state))
        OR (OLD.state = 'PENDING' AND NEW.state NOT IN ('PENDING', 'RUNNING'))
        OR (OLD.state = 'RUNNING' AND NEW.state NOT IN
            ('RUNNING', 'READY', 'BLOCKED', 'FAILED'))
        OR (NEW.state <> 'PENDING' AND (NEW.attemptId IS NULL
            OR NEW.attemptId NOT REGEXP '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'))
        OR (OLD.state = 'RUNNING' AND OLD.leasedUntil > CURRENT_TIMESTAMP(3)
            AND NOT (NEW.attemptId <=> OLD.attemptId)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'normalization queue identity or terminal state is immutable';
    END IF;
END$$

CREATE TRIGGER platform_normalization_queue_no_delete
BEFORE DELETE ON platform_normalization_queue
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'normalization queue is retained evidence and cannot be deleted';
END$$

CREATE TRIGGER platform_normalization_queue_audit_insert
AFTER INSERT ON platform_normalization_queue
FOR EACH ROW
BEGIN
    INSERT INTO platform_normalization_queue_event (queueId, taskId, attemptId, toState)
    VALUES (NEW.id, NEW.taskId, NEW.attemptId, NEW.state);
END$$

CREATE TRIGGER platform_normalization_queue_audit_update
AFTER UPDATE ON platform_normalization_queue
FOR EACH ROW
BEGIN
    IF NOT (NEW.state <=> OLD.state)
        OR NOT (NEW.attemptId <=> OLD.attemptId)
        OR NOT (NEW.leasedUntil <=> OLD.leasedUntil)
        OR NOT (NEW.resultCode <=> OLD.resultCode) THEN
        INSERT INTO platform_normalization_queue_event
            (queueId, taskId, attemptId, fromState, toState, reasonCode)
        VALUES (NEW.id, NEW.taskId, NEW.attemptId, OLD.state, NEW.state, NEW.resultCode);
    END IF;
END$$

CREATE TRIGGER platform_normalization_queue_event_no_update
BEFORE UPDATE ON platform_normalization_queue_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'normalization queue audit is immutable';
END$$

CREATE TRIGGER platform_normalization_queue_event_no_delete
BEFORE DELETE ON platform_normalization_queue_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'normalization queue audit is retained and cannot be deleted';
END$$

CREATE TRIGGER platform_run_progress_event_no_update
BEFORE UPDATE ON platform_run_progress_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'run progress events are append-only';
END$$

CREATE TRIGGER platform_run_progress_event_no_delete
BEFORE DELETE ON platform_run_progress_event
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'run progress events are retained evidence and cannot be deleted';
END$$
DELIMITER ;
