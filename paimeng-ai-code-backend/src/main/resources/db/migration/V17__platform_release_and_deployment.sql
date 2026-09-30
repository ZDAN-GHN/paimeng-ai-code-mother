-- 首次 Release、Deployment 与健康公开入口（Issue #81 / T-09）。
--
-- CT-004：Release 固定绑定 SourceRevision、Trusted Profile Version 与验证尝试；它不可变，
-- 事后无法解释「线上跑的到底是哪份代码」的场景因此在数据库层就不成立。
-- CT-005 / AD-016：Deployment 由 Platform 受控执行器从固定 Release 创建，不发布宿主机端口，
-- 内部健康检查通过才允许公开。Agent 没有任何写入这两张表的代码路径。
--
-- Deployment 刻意不建 `platform_task.state = 'RELEASED'` 的外键：AD-011 规定「已上线」由
-- 健康 Deployment 表达而不是 Task 状态，两者不能用外键绑成一个布尔。
CREATE TABLE platform_release (
    id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    appId BIGINT NOT NULL,
    taskId BIGINT NOT NULL,
    runId VARCHAR(64) NOT NULL,
    sourceRevisionId VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    profileVersionId BIGINT NOT NULL,
    baselineHash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    commitHash CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    treeHash CHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    validationAttemptId VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    -- 固定 Release 必须钉住运行时契约，否则事后改配置就会静默改变这个 Release 的含义。
    runtimeProfile VARCHAR(32) NOT NULL,
    createdTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    -- 一个 SourceRevision 只允许创建一个 Release：重放晋升不得产生第二个「固定版本」。
    UNIQUE KEY uk_release_revision (appId, sourceRevisionId),
    UNIQUE KEY uk_release_task (taskId),
    UNIQUE KEY uk_release_owner (id, appId),
    INDEX idx_release_app (appId, id),
    CONSTRAINT fk_release_app FOREIGN KEY (appId) REFERENCES app (id),
    CONSTRAINT fk_release_task FOREIGN KEY (taskId, appId) REFERENCES platform_task (id, appId),
    CONSTRAINT fk_release_run FOREIGN KEY (runId, appId, taskId)
        REFERENCES platform_run (id, appId, taskId),
    CONSTRAINT fk_release_source_revision FOREIGN KEY (sourceRevisionId, appId)
        REFERENCES platform_source_revision (id, appId),
    CONSTRAINT fk_release_profile FOREIGN KEY (profileVersionId, appId)
        REFERENCES platform_trusted_profile_version (id, appId),
    CONSTRAINT ck_release_identity CHECK (
        CHAR_LENGTH(TRIM(id)) > 0 AND CHAR_LENGTH(TRIM(runtimeProfile)) > 0
        AND runtimeProfile REGEXP '^[A-Z0-9_]{1,32}$'
        AND baselineHash REGEXP '^[0-9a-f]{64}$'
        AND commitHash REGEXP '^[0-9a-f]{40}$' AND treeHash REGEXP '^[0-9a-f]{40}$'
        AND validationAttemptId REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 一个 Release 至多一个 Deployment（首次发布切片内「一版一次部署」是契约，不是巧合）。
CREATE TABLE platform_deployment (
    id BIGINT NOT NULL AUTO_INCREMENT,
    appId BIGINT NOT NULL,
    releaseId VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    taskId BIGINT NOT NULL,
    -- CST-006：有副作用的 Platform 请求必须有幂等键。本切片内取 Release 身份派生，
    -- 因此同一 Release 的重放不会创建第二个 Deployment。
    requestId VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    state VARCHAR(32) NOT NULL,
    -- stage / reasonCode 是给 Owner 的受控诊断值域（白名单在 Java 侧 PlatformDeploymentStage
    -- 与 PlatformDeploymentReasonCode）。容器标识、网络地址和原始输出都不落这两列。
    stage VARCHAR(48) NOT NULL,
    reasonCode VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    attemptNumber INT NOT NULL DEFAULT 1,
    requestedTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updatedTime DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- healthyTime 一旦写入不再清空：AD-017 需要据此区分「从未健康」与「曾经健康」，
    -- 决定未上线路径该返回 404 还是 503。用列而不是状态位是因为状态会随部署推进变化。
    healthyTime DATETIME(3) NULL,
    -- 以下两列是 Docker 侧的内部事实，绝不进入任何对外投影。
    containerId VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    containerAddress VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_deployment_release (releaseId),
    UNIQUE KEY uk_deployment_request (appId, requestId),
    INDEX idx_deployment_app_state (appId, state),
    INDEX idx_deployment_queue (state, id),
    CONSTRAINT fk_deployment_release FOREIGN KEY (releaseId, appId)
        REFERENCES platform_release (id, appId),
    CONSTRAINT ck_deployment_state CHECK (HEX(state) IN
        (HEX('PENDING'), HEX('PROVISIONING'), HEX('HEALTHY'), HEX('UNHEALTHY'))),
    -- HEALTHY 必须有 healthyTime，未健康状态必须没有：否则「已上线」这一事实会被后续更新抹掉。
    CONSTRAINT ck_deployment_healthy_time CHECK (
        (HEX(state) = HEX('HEALTHY') AND healthyTime IS NOT NULL)
        OR (HEX(state) <> HEX('HEALTHY') AND healthyTime IS NULL)
    ),
    CONSTRAINT ck_deployment_attempt CHECK (attemptNumber >= 1)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DELIMITER $$
-- Release 的身份全部来自晋升结果，逐列抄写会让「固定版本」名存实亡：
-- 只要有一列与被晋升的 SourceRevision 不一致，就说明有人伪造了一个 Release。
CREATE TRIGGER platform_release_insert_guard
BEFORE INSERT ON platform_release FOR EACH ROW
BEGIN
    IF NOT EXISTS (SELECT 1 FROM platform_source_revision r
        WHERE HEX(r.id) = HEX(NEW.sourceRevisionId) AND r.appId = NEW.appId
          AND r.taskId = NEW.taskId AND HEX(r.runId) = HEX(NEW.runId)
          AND HEX(r.baselineHash) = HEX(NEW.baselineHash)
          AND r.profileVersionId = NEW.profileVersionId
          AND HEX(r.commitHash) = HEX(NEW.commitHash)
          AND HEX(r.treeHash) = HEX(NEW.treeHash)
          AND HEX(r.validationAttemptId) = HEX(NEW.validationAttemptId))
        OR NOT EXISTS (SELECT 1 FROM platform_task t
            WHERE t.id = NEW.taskId AND t.appId = NEW.appId AND HEX(t.state) = HEX('VALIDATED'))
    THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'release requires the matching promoted source revision';
    END IF;
END$$
CREATE TRIGGER platform_release_immutable
BEFORE UPDATE ON platform_release FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'release is fixed and cannot be updated';
END$$
CREATE TRIGGER platform_release_no_delete
BEFORE DELETE ON platform_release FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'release cannot be deleted';
END$$

-- Deployment 一旦进入终态就不可再改：HEALTHY / UNHEALTHY 之间的反复横跳会让「当前是否已上线」
-- 变成一个随时可能被覆盖的读。
CREATE TRIGGER platform_deployment_terminal_guard
BEFORE UPDATE ON platform_deployment FOR EACH ROW
BEGIN
    IF BINARY OLD.state IN (BINARY 'HEALTHY', BINARY 'UNHEALTHY')
        AND NOT (BINARY OLD.state <=> BINARY NEW.state)
    THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'terminal deployment state cannot change';
    END IF;
END$$
CREATE TRIGGER platform_deployment_no_delete
BEFORE DELETE ON platform_deployment FOR EACH ROW
BEGIN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'deployment cannot be deleted';
END$$
DELIMITER ;