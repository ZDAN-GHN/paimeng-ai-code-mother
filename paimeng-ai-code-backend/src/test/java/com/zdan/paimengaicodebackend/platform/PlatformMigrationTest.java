package com.zdan.paimengaicodebackend.platform;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class PlatformMigrationTest {

    @Test
    void migrationsUnifyTheApplicationRootAndNormalizePlatformFieldNames() throws Exception {
        String v1 = resource("/db/migration/V1__platform_domain.sql");
        String v2 = resource("/db/migration/V2__platform_domain_text_and_collation.sql");
        String v3 = resource("/db/migration/V3__platform_requirement_immutable.sql");
        String v4 = resource("/db/migration/V4__platform_integrity_and_audit.sql");
        String v5 = resource("/db/migration/V5__platform_audit_events_append_only.sql");
        String v6 = resource("/db/migration/V6__unify_app_root_and_platform_field_names.sql");
        String v7 = resource("/db/migration/V7__remove_legacy_run_and_credit.sql");
        String v8 = resource("/db/migration/V8__platform_run_lease.sql");
        String v9 = resource("/db/migration/V9__platform_run_recovery_checkpoint.sql");

        assertTrue(v1.contains("CREATE TABLE platform_application"));
        assertTrue(v1.contains("CREATE TABLE platform_requirement"));
        assertTrue(v1.contains("CREATE TABLE platform_task"));
        assertTrue(v1.contains("CREATE TABLE platform_run"));
        assertTrue(v1.contains("CREATE TABLE platform_trusted_profile_version"));
        assertTrue(!v1.contains("ALTER TABLE app"));
        assertTrue(!v1.contains("credit_ledger"));
        assertTrue(v2.contains("MODIFY acceptance_target TEXT"));
        assertTrue(v2.contains("utf8mb4_unicode_ci"));
        assertTrue(v3.contains("CREATE TRIGGER platform_requirement_immutable"));
        assertTrue(v4.contains("ADD COLUMN is_deleted"));
        assertTrue(v4.contains("platform_task_baseline_immutable"));
        assertTrue(v4.contains("platform_requirement_no_delete"));
        assertTrue(!v4.contains("FOREIGN KEY"));
        assertTrue(v5.contains("platform_application_lifecycle_event_no_update"));
        assertTrue(v5.contains("platform_task_transition_event_no_delete"));
        assertTrue(v5.contains("platform_run_transition_event_no_update"));
        assertTrue(!v5.contains("is_deleted"));
        assertTrue(v6.contains("ALTER TABLE app"));
        assertTrue(v6.contains("lifecycleStatus"));
        assertTrue(v6.contains("archivedTime"));
        assertTrue(v6.contains("INSERT INTO app"));
        assertTrue(v6.contains("DROP TABLE platform_application"));
        assertTrue(v6.contains("RENAME COLUMN application_id TO appId"));
        assertTrue(v6.contains("RENAME COLUMN baseline_json TO baselineJson"));
        assertTrue(v7.contains("DROP TABLE IF EXISTS generation_run"));
        assertTrue(v7.contains("DROP TABLE IF EXISTS credit_ledger"));
        assertTrue(v7.contains("remove_user_credits_column"));
        assertTrue(v7.contains("ALTER TABLE user DROP COLUMN credits"));

        assertTrue(v8.contains("CREATE TABLE platform_run_lease"));
        assertTrue(v8.contains("CREATE TABLE platform_run_lease_event"));
        assertTrue(v8.contains("UNIQUE KEY uk_platform_run_lease_app (appId)"));
        assertTrue(v8.contains("UNIQUE KEY uk_platform_run_lease_request (runId, eventType, requestId)"));
        assertTrue(v8.contains("fenceToken BIGINT NOT NULL"));
        assertTrue(v8.contains("platform_run_lease_event_no_update"));
        assertTrue(v8.contains("platform_run_lease_event_no_delete"));
        assertTrue(!v8.contains("platform_run_lease_no_delete"));
        assertTrue(!v8.contains("FOREIGN KEY"));
        assertTrue(!v8.contains("application_id"));

        assertTrue(v9.contains("CREATE TABLE platform_run_recovery_checkpoint"));
        assertTrue(v9.contains("CREATE TABLE platform_run_command_request"));
        assertTrue(v9.contains("UNIQUE KEY uk_platform_run_command_request (runId, requestId)"));
        assertTrue(v9.contains("containerId VARCHAR(64) NOT NULL"));
        assertTrue(!v9.contains("ALTER TABLE platform_run"));
        assertTrue(!v9.contains("DROP TABLE"));
    }

    @Test
    void sourceRevisionMigrationIsAppendOnlyAndPreservesLegacyPointer() throws Exception {
        String v12 = resource("/db/migration/V12__platform_source_revision.sql");
        assertTrue(v12.contains("stableSourceRevision VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL"));
        assertTrue(v12.contains("CREATE TABLE platform_source_revision"));
        assertTrue(v12.contains("fk_app_stable_revision"));
        assertTrue(v12.contains("source_revision_insert_guard"));
        assertTrue(v12.contains("source_revision_immutable"));
        assertTrue(v12.contains("source_revision_no_delete"));
        assertTrue(!v12.contains("DROP TABLE"));
        String v13 = resource("/db/migration/V13__platform_validation_queue.sql");
        assertTrue(v13.contains("CREATE TABLE platform_validation_queue"));
        assertTrue(v13.contains("AFTER INSERT ON platform_run_transition_event"));
        assertTrue(v13.contains("platform_validation_queue_event_no_delete"));
        assertTrue(!v13.contains("DROP TABLE"));
        String v14 = resource("/db/migration/V14__database_constraint_governance.sql");
        // 业务写入不再由触发器代劳，状态机守卫仍在
        assertTrue(v14.contains("DROP TRIGGER platform_run_success_enqueue"));
        assertTrue(v14.contains("DROP TRIGGER platform_validation_queue_audit_insert"));
        assertTrue(v14.contains("DROP TRIGGER platform_validation_queue_audit_update"));
        assertTrue(!v14.contains("DROP TRIGGER platform_validation_queue_identity_guard"));
        assertTrue(!v14.contains("DROP TRIGGER platform_validation_queue_no_delete"));
        // 与守卫完全重叠的单列证据外键必须删除，跨聚合归属外键必须保留
        assertTrue(v14.contains("DROP FOREIGN KEY fk_validation_queue_event"));
        assertTrue(v14.contains("DROP FOREIGN KEY fk_validation_queue_run"));
        assertTrue(v14.contains("DROP FOREIGN KEY fk_source_revision_engineering"));
        assertTrue(v14.contains("DROP FOREIGN KEY fk_source_revision_task_acceptance"));
        assertTrue(!v14.contains("DROP FOREIGN KEY fk_source_revision_app"));
        assertTrue(!v14.contains("DROP FOREIGN KEY fk_source_revision_snapshot"));
        // 被左前缀覆盖的重复索引必须删除
        assertTrue(v14.contains("DROP INDEX idx_userId ON app"));
        assertTrue(!v14.contains("DROP INDEX idx_app_userId_lifecycleStatus"));
        // 每张表都必须显式声明字符集，不再依赖服务端默认值
        assertTrue(v14.contains("ALTER TABLE platform_validation_queue\n"
            + "    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"));
        assertTrue(v14.contains("CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"));
        assertTrue(!v14.contains("DEFAULT CHARACTER SET"));
    }

    /**
     * Issue #81 的结构契约。
     *
     * <p>要钉住的不是「建了两张表」，而是三条真实不变量：Release 不可变且必须与被晋升的
     * SourceRevision 逐列一致；一个 SourceRevision 只能产生一个 Release；「已上线」这一事实
     * 只能由带 healthyTime 的 Deployment 表达，因此 HEALTHY 与 healthyTime 必须同时成立。
     */
    @Test
    void releaseAndDeploymentMigrationKeepsTheFixedEvidenceChain() throws Exception {
        String v17 = resource("/db/migration/V17__platform_release_and_deployment.sql");

        assertTrue(v17.contains("CREATE TABLE platform_release"));
        assertTrue(v17.contains("CREATE TABLE platform_deployment"));
        // 一个 SourceRevision 至多一个 Release：晋升重放不得产生第二个「固定版本」。
        assertTrue(v17.contains("UNIQUE KEY uk_release_revision (appId, sourceRevisionId)"));
        assertTrue(v17.contains("UNIQUE KEY uk_release_task (taskId)"));
        assertTrue(v17.contains("UNIQUE KEY uk_deployment_release (releaseId)"));
        // CST-006：有副作用的 Platform 请求必须可幂等重放。
        assertTrue(v17.contains("UNIQUE KEY uk_deployment_request (appId, requestId)"));
        // Release 必须钉住运行时契约，否则事后改配置会静默改变已发布版本的含义。
        assertTrue(v17.contains("runtimeProfile VARCHAR(32) NOT NULL"));
        assertTrue(v17.contains("runtimeProfile REGEXP '^[A-Z0-9_]{1,32}$'"));
        // 「已上线」不能被后续更新抹掉。
        assertTrue(v17.contains("CONSTRAINT ck_deployment_healthy_time CHECK"));
        assertTrue(v17.contains("HEX(state) = HEX('HEALTHY') AND healthyTime IS NOT NULL"));
        // 不可变与终态保护。
        assertTrue(v17.contains("CREATE TRIGGER platform_release_insert_guard"));
        assertTrue(v17.contains("CREATE TRIGGER platform_release_immutable"));
        assertTrue(v17.contains("CREATE TRIGGER platform_release_no_delete"));
        assertTrue(v17.contains("CREATE TRIGGER platform_deployment_terminal_guard"));
        assertTrue(v17.contains("CREATE TRIGGER platform_deployment_no_delete"));
        // AD-010：「已上线」由 Deployment 表达，不与 Task 状态绑成同一个布尔。
        assertTrue(!v17.contains("FOREIGN KEY (releaseId, appId) REFERENCES platform_release (id, appId, taskId)"));
        assertTrue(!v17.contains("DROP TABLE"));
        assertTrue(v17.contains("DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"));
    }

    private String resource(String path) throws Exception {
        try (InputStream stream = getClass().getResourceAsStream(path)) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
