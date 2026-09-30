-- Owner 显式重试的持久事实（Issue #80 / Slice 2）。
--
-- D-06 的 `failed -> ready` 前置条件是「Owner 显式请求重试」。此前该条件由调用方以布尔自报，
-- 与 Lease 前置条件当初被 `withLeaseFacts` 消除自报之前是同一种漏洞：任何内部调用方都能
-- 传 actor=OWNER、reasonCode=重试码来伪造一次 Owner 请求。本表让这条前置条件变成可实查的事实。
CREATE TABLE platform_task_retry_request (
    id BIGINT NOT NULL AUTO_INCREMENT,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    requestId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    actorType VARCHAR(32) NOT NULL,
    reason VARCHAR(500) NULL,
    createdTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_task_retry_request (taskId, requestId),
    INDEX idx_task_retry_task (taskId, id),
    -- 与 V14 一致用 HEX() 做大小写敏感比较：列是 ci collation，朴素比较会让 'owner' 通过值域约束。
    CONSTRAINT ck_task_retry_actor CHECK (HEX(actorType) IN
        (HEX('OWNER'), HEX('SYSTEM_ADMINISTRATOR')))
) COMMENT='Append-only record of an explicit Owner retry request';

DELIMITER $$
-- 只允许追加：重试请求一旦受理就是审计证据，事后改写会让 `failed -> ready` 无法解释。
CREATE TRIGGER platform_task_retry_request_no_update
BEFORE UPDATE ON platform_task_retry_request
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retry request is retained evidence and cannot be updated';
END$$

CREATE TRIGGER platform_task_retry_request_no_delete
BEFORE DELETE ON platform_task_retry_request
FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'retry request is retained evidence and cannot be deleted';
END$$
DELIMITER ;