CREATE TABLE platform_application (
    id BIGINT NOT NULL,
    owner_id BIGINT NOT NULL,
    name VARCHAR(256) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_platform_application_owner_id (owner_id)
) COMMENT='Platform application aggregate';

CREATE TABLE platform_requirement (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    parent_requirement_id BIGINT NULL,
    kind VARCHAR(32) NOT NULL,
    original_text LONGTEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_platform_requirement_application_id (application_id),
    INDEX idx_platform_requirement_parent_id (parent_requirement_id)
) COMMENT='Immutable owner requirement or clarification answer';

CREATE TABLE platform_trusted_profile_version (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    version_number BIGINT NOT NULL,
    profile_json JSON NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_profile_application_version (application_id, version_number)
) COMMENT='Trusted product profile version';

CREATE TABLE platform_task (
    id BIGINT NOT NULL,
    application_id BIGINT NOT NULL,
    requirement_id BIGINT NOT NULL,
    parent_task_id BIGINT NULL,
    state VARCHAR(32) NOT NULL,
    blocked_question TEXT NULL,
    baseline_schema_version INT NULL,
    base_profile_version BIGINT NULL,
    base_source_revision VARCHAR(128) NULL,
    requested_outcome TEXT NULL,
    acceptance_target JSON NULL,
    baseline_json JSON NULL,
    failure_code VARCHAR(64) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    INDEX idx_platform_task_application_state (application_id, state),
    INDEX idx_platform_task_requirement_id (requirement_id),
    INDEX idx_platform_task_parent_id (parent_task_id)
) COMMENT='Controlled platform delivery task';

CREATE TABLE platform_run (
    id VARCHAR(64) NOT NULL,
    application_id BIGINT NOT NULL,
    task_id BIGINT NOT NULL,
    state VARCHAR(32) NOT NULL,
    attempt_number INT NOT NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_platform_run_task_attempt (task_id, attempt_number),
    INDEX idx_platform_run_application_state (application_id, state)
) COMMENT='Persistent controlled execution attempt';
