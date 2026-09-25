CREATE TABLE platform_run_recovery_checkpoint (
    runId VARCHAR(64) NOT NULL,
    appId BIGINT NOT NULL,
    fenceToken BIGINT NOT NULL,
    containerId VARCHAR(64) NOT NULL,
    phase VARCHAR(16) NOT NULL,
    preparedRequestId VARCHAR(64) NOT NULL,
    beginRequestId VARCHAR(64) NULL,
    resumeRequestId VARCHAR(64) NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (runId),
    INDEX idx_platform_run_recovery_app (appId)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Pre-request recovery checkpoint; only PREPARED can be claimed by a restarted Runtime';

CREATE TABLE platform_run_command_request (
    id BIGINT NOT NULL,
    appId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    requestId VARCHAR(64) NOT NULL,
    fenceToken BIGINT NOT NULL,
    commandHash CHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL,
    exitCode INT NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finishedTime DATETIME NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_run_command_request (runId, requestId),
    INDEX idx_platform_run_command_app_time (appId, createdTime)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='At-most-once Sandbox command requests; unknown outcomes remain STARTED and never rerun';
