CREATE TABLE platform_run_lease (
    id BIGINT NOT NULL,
    appId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    taskId BIGINT NOT NULL,
    fenceToken BIGINT NOT NULL,
    grantedTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expiresTime DATETIME NOT NULL,
    renewCount INT NOT NULL DEFAULT 0,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_run_lease_app (appId),
    UNIQUE KEY uk_platform_run_lease_run (runId),
    INDEX idx_platform_run_lease_task (taskId),
    INDEX idx_platform_run_lease_expires (expiresTime)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Active write lease; at most one row per Application. Release deletes the row, evidence lives in platform_run_lease_event';

CREATE TABLE platform_run_lease_event (
    id BIGINT NOT NULL,
    appId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    taskId BIGINT NOT NULL,
    eventType VARCHAR(32) NOT NULL,
    fenceToken BIGINT NOT NULL,
    actorType VARCHAR(32) NOT NULL,
    reasonCode VARCHAR(64) NULL,
    requestId VARCHAR(64) NOT NULL,
    occurredTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_run_lease_request (runId, eventType, requestId),
    INDEX idx_platform_run_lease_event_app_fence (appId, fenceToken),
    INDEX idx_platform_run_lease_event_app_time (appId, occurredTime),
    INDEX idx_platform_run_lease_event_run_time (runId, occurredTime)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Append-only platform run lease audit event; retains evidence for deleted active lease rows';

CREATE TRIGGER platform_run_lease_event_no_update
BEFORE UPDATE ON platform_run_lease_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_run_lease_event is append-only';

CREATE TRIGGER platform_run_lease_event_no_delete
BEFORE DELETE ON platform_run_lease_event
FOR EACH ROW
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform_run_lease_event is append-only';
