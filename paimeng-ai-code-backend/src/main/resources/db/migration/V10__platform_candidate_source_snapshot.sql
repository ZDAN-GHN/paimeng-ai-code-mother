CREATE TABLE platform_candidate_source_snapshot (
    runId VARCHAR(64) NOT NULL,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    requestId VARCHAR(64) NOT NULL,
    fenceToken BIGINT NOT NULL,
    baselineHash CHAR(64) NOT NULL,
    baseSourceRevision VARCHAR(128) NULL,
    status VARCHAR(16) NOT NULL,
    commitHash CHAR(40) NULL,
    treeHash CHAR(40) NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (runId),
    INDEX idx_candidate_snapshot_app_task (appId, taskId)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Immutable per-Run candidate identity; FREEZING is never a validation input';
