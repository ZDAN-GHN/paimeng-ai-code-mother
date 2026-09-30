-- 数据库约束治理：先修缺陷，再删冗余，最后用数据库原生能力补齐行内不变量。
--
-- 判定原则（与 Issue 79 已验收的四门权威模型一致）：
--   NOT NULL / PRIMARY KEY > UNIQUE > CHECK > 必要的 FOREIGN KEY > 事务边界 > 应用层显式逻辑 > Trigger
--
-- 本次动作：
--   1) 修缺陷：5 张表在 V4/V13 未声明字符集，隐式继承了 MySQL 8 的 utf8mb4_0900_ai_ci，
--      与项目统一的 utf8mb4_unicode_ci 混用会产生 Illegal mix of collations。
--   2) 删冗余：队列登记与审计写入是普通业务流程，触发器代写业务数据属于过度设计。
--   3) 删冗余：4 个单列证据外键与 source_revision_insert_guard 完全重叠，只增加写放大。
--   4) 删冗余：被复合索引左前缀覆盖的重复单列索引。
--   5) 补约束：状态值域、数值边界、哈希格式、attemptId 格式全部下沉为 CHECK。

-- ---------------------------------------------------------------------------
-- 1. 排序规则对齐：显式声明，不再依赖服务端默认值
-- ---------------------------------------------------------------------------
ALTER TABLE platform_application_lifecycle_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE platform_task_transition_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE platform_run_transition_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE platform_validation_queue
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE platform_validation_queue_event
    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. 删除代写业务数据的触发器
--    platform_run_success_enqueue   -> PlatformRunTransitionService.transition 同事务登记
--    platform_validation_queue_audit_insert / _audit_update -> PlatformValidationQueueService 显式追加
--    两者都是"同一事务内的一行 insert"，数据库层没有非它不可的表达力。
--    platform_validation_queue_identity_guard 保留：它比较 NEW/OLD，CHECK 无法表达状态机迁移图。
-- ---------------------------------------------------------------------------
DROP TRIGGER platform_run_success_enqueue;
DROP TRIGGER platform_validation_queue_audit_insert;
DROP TRIGGER platform_validation_queue_audit_update;

-- ---------------------------------------------------------------------------
-- 3. 删除被复合索引左前缀完全覆盖的重复单列索引
-- ---------------------------------------------------------------------------
DROP INDEX idx_userId ON app;
DROP INDEX idx_appId ON chat_history;

-- ---------------------------------------------------------------------------
-- 4. 删除与写入方完全重叠、且实测造成锁等待的外键
--
--    fk_validation_queue_event / fk_validation_queue_run：
--    队列行的 eventId 与 runId 都由 PlatformRunTransitionService 在同一事务里从刚插入的
--    转换事件直接取得，"父行是否存在"没有任何额外的保护价值；而 InnoDB 会为子表 INSERT
--    对父行加 S 锁，当父行正是同一业务操作刚写入的行时会与自身持有的 X 锁竞争，
--    实测稳定复现 50s "Lock wait timeout exceeded"。
--
--    fk_source_revision_{engineering,database,runtime,task_acceptance}：
--    外键只断言"证据行存在"，守卫同时断言 category / attemptId / issuer / result，
--    前者是后者的真子集，这 4 个外键只是给晋升热路径增加 4 个二级索引。
--    跨聚合归属外键（app / task / run / snapshot / profile）保留，仍是领域不变量。
-- ---------------------------------------------------------------------------
ALTER TABLE platform_validation_queue
    DROP FOREIGN KEY fk_validation_queue_event,
    DROP FOREIGN KEY fk_validation_queue_run;

ALTER TABLE platform_source_revision
    DROP FOREIGN KEY fk_source_revision_engineering,
    DROP FOREIGN KEY fk_source_revision_database,
    DROP FOREIGN KEY fk_source_revision_runtime,
    DROP FOREIGN KEY fk_source_revision_task_acceptance;

-- ---------------------------------------------------------------------------
-- 5. 状态值域：与 Java 枚举一一对应，写入侧无法产生枚举外的值
-- ---------------------------------------------------------------------------
ALTER TABLE platform_task
    ADD CONSTRAINT ck_platform_task_state CHECK (HEX(state) IN
        (HEX('CREATED'), HEX('READY'), HEX('EXECUTING'), HEX('BLOCKED'),
         HEX('FAILED'), HEX('VALIDATED'), HEX('RELEASED'), HEX('CANCELLED')));

ALTER TABLE platform_run
    ADD CONSTRAINT ck_platform_run_state CHECK (HEX(state) IN
        (HEX('CREATED'), HEX('LEASED'), HEX('EXECUTING'), HEX('SUCCEEDED'),
         HEX('FAILED'), HEX('CANCELLED'))),
    ADD CONSTRAINT ck_platform_run_attempt CHECK (attemptNumber >= 1);

ALTER TABLE platform_task_transition_event
    ADD CONSTRAINT ck_task_transition_state CHECK (
        HEX(fromState) IN (HEX('CREATED'), HEX('READY'), HEX('EXECUTING'), HEX('BLOCKED'),
            HEX('FAILED'), HEX('VALIDATED'), HEX('RELEASED'), HEX('CANCELLED'))
        AND HEX(toState) IN (HEX('CREATED'), HEX('READY'), HEX('EXECUTING'), HEX('BLOCKED'),
            HEX('FAILED'), HEX('VALIDATED'), HEX('RELEASED'), HEX('CANCELLED'))),
    ADD CONSTRAINT ck_task_transition_actor CHECK (HEX(actorType) IN
        (HEX('OWNER'), HEX('SYSTEM_ADMINISTRATOR'), HEX('PLATFORM'), HEX('RUNTIME'), HEX('AGENT')));

ALTER TABLE platform_run_transition_event
    ADD CONSTRAINT ck_run_transition_state CHECK (
        HEX(fromState) IN (HEX('CREATED'), HEX('LEASED'), HEX('EXECUTING'), HEX('SUCCEEDED'),
            HEX('FAILED'), HEX('CANCELLED'))
        AND HEX(toState) IN (HEX('CREATED'), HEX('LEASED'), HEX('EXECUTING'), HEX('SUCCEEDED'),
            HEX('FAILED'), HEX('CANCELLED'))),
    ADD CONSTRAINT ck_run_transition_actor CHECK (HEX(actorType) IN
        (HEX('OWNER'), HEX('SYSTEM_ADMINISTRATOR'), HEX('PLATFORM'), HEX('RUNTIME'), HEX('AGENT')));

ALTER TABLE platform_application_lifecycle_event
    ADD CONSTRAINT ck_application_lifecycle_event CHECK (
        HEX(eventType) = HEX('ARCHIVED') AND HEX(actorType) IN
        (HEX('OWNER'), HEX('SYSTEM_ADMINISTRATOR'), HEX('PLATFORM'), HEX('RUNTIME'), HEX('AGENT'))),
    ADD CONSTRAINT ck_application_lifecycle_request CHECK (CHAR_LENGTH(TRIM(requestId)) > 0);

-- reasonCode 是自由诊断文本（实测 12 种取值），不是枚举，不建约束
ALTER TABLE platform_run_lease_event
    ADD CONSTRAINT ck_run_lease_event CHECK (
        HEX(eventType) IN (HEX('GRANTED'), HEX('RENEWED'), HEX('RELEASED'), HEX('EXPIRED'), HEX('REJECTED'))
        AND HEX(actorType) IN
        (HEX('OWNER'), HEX('SYSTEM_ADMINISTRATOR'), HEX('PLATFORM'), HEX('RUNTIME'), HEX('AGENT'))
        AND CHAR_LENGTH(TRIM(requestId)) > 0);

ALTER TABLE platform_candidate_source_snapshot
    ADD CONSTRAINT ck_candidate_snapshot_status CHECK (
        HEX(status) IN (HEX('FREEZING'), HEX('READY'), HEX('ABORTED')) AND fenceToken >= 1),
    ADD CONSTRAINT ck_candidate_snapshot_identity CHECK (
        REGEXP_LIKE(baselineHash, '^[0-9a-f]{64}$', 'c')
        AND REGEXP_LIKE(commitHash, '^[0-9a-f]{40}$', 'c')
        AND REGEXP_LIKE(treeHash, '^[0-9a-f]{40}$', 'c'));

ALTER TABLE platform_profile_disposition
    ADD CONSTRAINT ck_profile_disposition_hash CHECK (
        REGEXP_LIKE(baselineHash, '^[0-9a-f]{64}$', 'c')
        AND REGEXP_LIKE(commitHash, '^[0-9a-f]{40}$', 'c')
        AND REGEXP_LIKE(treeHash, '^[0-9a-f]{40}$', 'c'));

ALTER TABLE platform_validation_evidence
    ADD CONSTRAINT ck_validation_evidence_hash CHECK (
        REGEXP_LIKE(baselineHash, '^[0-9a-f]{64}$', 'c')
        AND REGEXP_LIKE(commitHash, '^[0-9a-f]{40}$', 'c')
        AND REGEXP_LIKE(treeHash, '^[0-9a-f]{40}$', 'c'));

-- ---------------------------------------------------------------------------
-- 6. 数值边界：与 Java 侧常量一致，值域只由生产写入路径使用
-- ---------------------------------------------------------------------------
ALTER TABLE platform_run_lease
    ADD CONSTRAINT ck_run_lease_renew CHECK (renewCount BETWEEN 0 AND 3),
    ADD CONSTRAINT ck_run_lease_fence CHECK (fenceToken >= 1);

ALTER TABLE platform_run_recovery_checkpoint
    ADD CONSTRAINT ck_run_recovery_phase CHECK (HEX(phase) IN (HEX('PREPARED'), HEX('STARTED'))),
    ADD CONSTRAINT ck_run_recovery_fence CHECK (fenceToken >= 1);

ALTER TABLE platform_run_command_request
    ADD CONSTRAINT ck_run_command_status CHECK (HEX(status) IN (HEX('STARTED'), HEX('COMPLETED'))),
    ADD CONSTRAINT ck_run_command_fence CHECK (fenceToken >= 1),
    ADD CONSTRAINT ck_run_command_exit CHECK (exitCode IS NULL OR exitCode BETWEEN 0 AND 255);

ALTER TABLE platform_trusted_profile_version
    ADD CONSTRAINT ck_profile_version CHECK (versionNumber >= 1);

-- ---------------------------------------------------------------------------
-- 7. 生命周期与逻辑删除
--    app.isDelete 由 MyBatis-Flex 逻辑删除改写，不做物理删除，故不加 BEFORE DELETE 触发器；
--    isDelete 只允许 0/1，lifecycleStatus 只允许活动/归档，两者与 FK 生命周期互不冲突。
-- ---------------------------------------------------------------------------
ALTER TABLE app
    ADD CONSTRAINT ck_app_lifecycle CHECK (HEX(lifecycleStatus) IN (HEX('ACTIVE'), HEX('ARCHIVED'))),
    ADD CONSTRAINT ck_app_is_delete CHECK (isDelete IN (0, 1)),
    MODIFY COLUMN appName VARCHAR(256) NOT NULL COMMENT '应用名称';

ALTER TABLE user
    ADD CONSTRAINT ck_user_is_delete CHECK (isDelete IN (0, 1)),
    ADD CONSTRAINT ck_user_role CHECK (HEX(userRole) IN (HEX('user'), HEX('admin')));

ALTER TABLE chat_history
    ADD CONSTRAINT ck_chat_history_is_delete CHECK (isDelete IN (0, 1)),
    ADD CONSTRAINT ck_chat_history_message_type CHECK (HEX(messageType) IN (HEX('user'), HEX('ai')));

-- ---------------------------------------------------------------------------
-- 8. 验证队列：把行内不变量从触发器搬进 CHECK
--    触发器里 "非 PENDING 必须有合法 attemptId" 是纯行内判断，不需要 OLD，可以下沉；
--    大写十六进制分支不可达（Java 侧只产生 UUID.randomUUID()），与 ck_validation_issuer 对齐。
-- ---------------------------------------------------------------------------
-- 拆分写：MySQL 在同一条 ALTER 里同时 DROP CHECK 与 ADD ... REGEXP_LIKE 会解析失败
ALTER TABLE platform_validation_queue
    DROP CHECK ck_validation_queue_attempt;

ALTER TABLE platform_validation_queue
    ADD CONSTRAINT ck_validation_queue_attempt CHECK (
        attemptNumber >= 0
        AND ((HEX(state) = HEX('PENDING') AND attemptId IS NULL)
            OR (HEX(state) <> HEX('PENDING') AND attemptId IS NOT NULL
                AND attemptId REGEXP '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')));

ALTER TABLE platform_validation_queue_event
    ADD CONSTRAINT ck_validation_queue_event CHECK (
        HEX(toState) IN (HEX('PENDING'), HEX('RUNNING'), HEX('PASS'), HEX('FAIL'),
            HEX('INCONCLUSIVE'), HEX('CLEANUP_FAILED'))
        AND (fromState IS NULL OR HEX(fromState) IN (HEX('PENDING'), HEX('RUNNING'), HEX('PASS'),
            HEX('FAIL'), HEX('INCONCLUSIVE'), HEX('CLEANUP_FAILED')))
        AND (attemptId IS NULL
            OR attemptId REGEXP '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'));

-- ---------------------------------------------------------------------------
-- 9. SourceRevision：id 由 UUID 生成，补上格式约束以对齐 app.stableSourceRevision 的二进制比较
-- ---------------------------------------------------------------------------
ALTER TABLE platform_source_revision
    ADD CONSTRAINT ck_source_revision_id CHECK (
        id REGEXP '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
