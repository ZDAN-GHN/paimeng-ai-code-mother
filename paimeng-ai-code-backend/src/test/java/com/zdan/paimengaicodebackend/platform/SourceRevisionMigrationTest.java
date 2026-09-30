package com.zdan.paimengaicodebackend.platform;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/** Runs only against a caller-provisioned, empty, isolated MySQL 8 database. */
@EnabledIfEnvironmentVariable(named = "ISSUE79_ISOLATED_MYSQL_URL", matches = ".+")
class SourceRevisionMigrationTest {
    private static final String BASELINE_JSON = "{\"schemaVersion\":1}";
    private static final String COMMIT = "b".repeat(40);
    private static final String TREE = "c".repeat(40);
    private static final String ATTEMPT = "11111111-2222-3333-4444-555555555555";
    private static final String[] CATEGORIES = {"ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE"};

    @Test
    void migratesOldRowsAndRejectsForeignIdentityInvalidEvidenceAndMutation() throws Exception {
        String url = System.getenv("ISSUE79_ISOLATED_MYSQL_URL");
        assertTrue(url.matches("jdbc:mysql://127\\.0\\.0\\.1:(?!3306)\\d+/issue79_[a-zA-Z0-9_]+"),
            "Only an explicitly provisioned isolated localhost database on a non-default port is allowed");
        String user = System.getenv("ISSUE79_ISOLATED_MYSQL_USER");
        String password = System.getenv("ISSUE79_ISOLATED_MYSQL_PASSWORD");
        assertTrue(user != null && !user.isBlank() && password != null, "Explicit test credentials required");

        try (Connection db = DriverManager.getConnection(url, user, password)) {
            try (ResultSet tables = db.getMetaData().getTables(db.getCatalog(), null, "%", new String[]{"TABLE"})) {
                assertTrue(!tables.next(), "Refusing to migrate a nonempty database");
            }
            execute(db, "CREATE TABLE app (id BIGINT NOT NULL PRIMARY KEY, userId BIGINT NOT NULL, "
                + "appName VARCHAR(256), codeGenType VARCHAR(64), editTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "
                + "createTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "
                + "updateTime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, isDelete TINYINT NOT NULL DEFAULT 0) ENGINE=InnoDB");
            migrate(url, user, password, "11");
            execute(db, "INSERT INTO app (id, userId, appName) VALUES (901, 1, 'old'), (902, 1, 'other')");
            execute(db, "INSERT INTO platform_requirement (id, appId, kind, originalText) VALUES (903, 901, 'OWNER', 'test')");
            execute(db, "INSERT INTO platform_task (id, appId, requirementId, state, baselineJson, baseProfileVersion) "
                + "VALUES (904, 901, 903, 'VALIDATED', '" + BASELINE_JSON + "', 905)");
            execute(db, "INSERT INTO platform_run (id, appId, taskId, state, attemptNumber) "
                + "VALUES ('old-run', 901, 904, 'SUCCEEDED', 1)");
            execute(db, "INSERT INTO platform_trusted_profile_version (id, appId, versionNumber, profileJson) "
                + "VALUES (905, 901, 1, '{}'), (906, 902, 1, '{}')");
            String baseline = scalar(db, "SELECT SHA2(baselineJson, 256) FROM platform_task WHERE id = 904");
            execute(db, "INSERT INTO platform_candidate_source_snapshot "
                + "(runId, appId, taskId, requestId, fenceToken, baselineHash, status, commitHash, treeHash) "
                + "VALUES ('old-run', 901, 904, 'freeze', 1, '" + baseline + "', 'READY', '" + COMMIT + "', '" + TREE + "')");
            execute(db, "INSERT INTO platform_profile_disposition "
                + "(runId, appId, taskId, baselineHash, commitHash, treeHash, disposition, reason) "
                + "VALUES ('old-run', 901, 904, '" + baseline + "', '" + COMMIT + "', '" + TREE
                + "', 'unchanged', 'synthetic')");
            for (int i = 0; i < CATEGORIES.length + 1; i++) {
                execute(db, "INSERT INTO platform_validation_evidence "
                    + "(id, appId, taskId, runId, baselineHash, commitHash, treeHash, category, result, "
                    + "payloadJson, payloadSha256, artifactRef, artifactCommitHash, artifactSha256, idempotencyKey) "
                    + "VALUES (" + (910 + i) + ", 901, 904, 'old-run', '" + baseline + "', '"
                    + COMMIT + "', '" + TREE + "', '" + (i == 4 ? "DATABASE" : CATEGORIES[i]) + "', 'PASS', '{\"ok\":true}', "
                    + "SHA2('{\"ok\":true}', 256), 'refs/evidence/" + "d".repeat(64) + "', '"
                    + "e".repeat(40) + "', '" + "f".repeat(64) + "', 'key-" + i + "')");
            }
            migrate(url, user, password, "12");
            assertEquals("12", scalar(db, "SELECT version FROM flyway_schema_history "
                + "WHERE success = 1 ORDER BY installed_rank DESC LIMIT 1"));
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_candidate_source_snapshot WHERE runId = 'old-run'"));
            assertEquals("5", scalar(db, "SELECT COUNT(*) FROM platform_validation_evidence WHERE runId = 'old-run'"));
            assertEquals("5", scalar(db, "SELECT COUNT(*) FROM platform_validation_evidence "
                + "WHERE runId = 'old-run' AND issuer = 'LEGACY' AND attemptId = 'LEGACY'"));
            assertEquals(null, scalar(db, "SELECT stableSourceRevision FROM app WHERE id = 901"));

            String insert = "INSERT INTO platform_source_revision (id, appId, taskId, runId, baselineHash, "
                + "commitHash, treeHash, profileVersionId, engineeringEvidenceId, databaseEvidenceId, "
                + "runtimeEvidenceId, taskAcceptanceEvidenceId, validationAttemptId) VALUES (?, 901, 904, 'old-run', '"
                + baseline + "', '" + COMMIT + "', '" + TREE + "', ?, ?, 921, 922, 923, '" + ATTEMPT + "')";
            assertThrows(SQLException.class, () -> revision(db, insert, "legacy-pass", 905, 910));
            for (int i = 0; i < CATEGORIES.length; i++) {
                execute(db, "INSERT INTO platform_validation_evidence "
                    + "(id, appId, taskId, runId, baselineHash, commitHash, treeHash, category, result, "
                    + "payloadJson, payloadSha256, artifactRef, artifactCommitHash, artifactSha256, idempotencyKey, issuer, attemptId) "
                    + "VALUES (" + (920 + i) + ", 901, 904, 'old-run', '" + baseline + "', '"
                    + COMMIT + "', '" + TREE + "', '" + CATEGORIES[i] + "', 'PASS', '{\"ok\":true}', "
                    + "SHA2('{\"ok\":true}', 256), 'refs/evidence/" + "d".repeat(64) + "', '"
                    + "e".repeat(40) + "', '" + "f".repeat(64) + "', 'validator-" + i
                    + "', 'PLATFORM_VALIDATOR_V1', '" + ATTEMPT + "')");
            }
            assertThrows(SQLException.class, () -> revision(db, insert, "wrong-profile", 906, 920));
            assertThrows(SQLException.class, () -> revision(db, insert.replace(COMMIT, "a".repeat(40)),
                "wrong-snapshot", 905, 920));
            assertThrows(SQLException.class, () -> revision(db, insert, "wrong-category", 905, 921));
            assertThrows(SQLException.class, () -> revision(db, insert.replace(ATTEMPT,
                "11111111-2222-3333-4444-666666666666"), "wrong-attempt", 905, 920));
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_task WHERE id = 904 AND appId = 901 "
                + "AND HEX(state) = HEX('VALIDATED') AND HEX(SHA2(baselineJson, 256)) = HEX('" + baseline + "') "
                + "AND HEX(baseSourceRevision) <=> HEX(NULL)"), "validated task");
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_run WHERE id = 'old-run' "
                + "AND appId = 901 AND taskId = 904 AND HEX(state) = HEX('SUCCEEDED')"), "successful run");
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_candidate_source_snapshot "
                + "WHERE runId = 'old-run' AND appId = 901 AND taskId = 904 "
                + "AND HEX(baselineHash) = HEX('" + baseline + "') "
                + "AND HEX(baseSourceRevision) <=> HEX(NULL) "
                + "AND HEX(commitHash) = HEX('" + COMMIT + "') AND HEX(treeHash) = HEX('" + TREE + "') "
                + "AND HEX(status) = HEX('READY')"), "ready snapshot");
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_profile_disposition "
                + "WHERE runId = 'old-run' AND appId = 901 AND taskId = 904 "
                + "AND HEX(baselineHash) = HEX('" + baseline + "') "
                + "AND HEX(baseSourceRevision) <=> HEX(NULL) "
                + "AND HEX(commitHash) = HEX('" + COMMIT + "') AND HEX(treeHash) = HEX('" + TREE + "') "
                + "AND HEX(disposition) = HEX('unchanged')"), "unchanged disposition");
            for (int i = 0; i < CATEGORIES.length; i++) {
                assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_validation_evidence "
                    + "WHERE id = " + (910 + i) + " AND appId = 901 AND taskId = 904 AND runId = 'old-run' "
                    + "AND HEX(baselineHash) = HEX('" + baseline + "') "
                    + "AND HEX(baseSourceRevision) <=> HEX(NULL) "
                    + "AND HEX(commitHash) = HEX('" + COMMIT + "') AND HEX(treeHash) = HEX('" + TREE + "') "
                    + "AND HEX(category) = HEX('" + CATEGORIES[i] + "') AND HEX(result) = HEX('PASS')"),
                    CATEGORIES[i] + " evidence");
            }
            revision(db, insert, "rev-1", 905, 920);
            assertThrows(SQLException.class, () -> revision(db, insert, "rev-2", 905, 920));
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE app SET stableSourceRevision = 'rev-1' WHERE id = 902"));
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE app SET stableSourceRevision = 'REV-1' WHERE id = 901"));
            execute(db, "UPDATE app SET stableSourceRevision = 'rev-1' WHERE id = 901");
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE platform_source_revision SET treeHash = '" + "a".repeat(40) + "' WHERE id = 'rev-1'"));
            assertThrows(SQLException.class, () -> execute(db, "DELETE FROM platform_source_revision WHERE id = 'rev-1'"));

            String event = "INSERT INTO platform_run_transition_event "
                + "(id, appId, runId, fromState, toState, actorType, requestId) "
                + "VALUES (?, 901, 'old-run', 'EXECUTING', 'SUCCEEDED', 'PLATFORM', ?)";
            insertEvent(db, event, 930L, "pre-migration");
            migrate(url, user, password, "13");
            assertEquals("0", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue"),
                "previously successful Runs must not be re-enqueued by the additive migration");
            db.setAutoCommit(false);
            try {
                insertEvent(db, event, 931L, "rolled-back");
                assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue WHERE runId = 'old-run'"));
                db.rollback();
            } finally {
                db.setAutoCommit(true);
            }
            assertEquals("0", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue"),
                "Run transition and queue insertion must share a transaction");
            insertEvent(db, event, 932L, "committed");
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue WHERE runId = 'old-run'"));
            assertEquals("1", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue_event WHERE runId = 'old-run'"));
            assertThrows(SQLException.class, () -> execute(db, "DELETE FROM platform_validation_queue WHERE runId = 'old-run'"));
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE platform_validation_queue SET state = 'PASS' WHERE runId = 'old-run'"));
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE platform_validation_queue SET state = 'RUNNING', attemptId = 'bad' WHERE runId = 'old-run'"));
            execute(db, "UPDATE platform_validation_queue SET state = 'RUNNING', attemptId = '" + ATTEMPT
                + "', leasedUntil = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE) WHERE runId = 'old-run'");
            assertThrows(SQLException.class, () -> execute(db,
                "UPDATE platform_validation_queue SET attemptId = '11111111-2222-3333-4444-666666666666' "
                    + "WHERE runId = 'old-run'"));
            assertEquals("2", scalar(db, "SELECT COUNT(*) FROM platform_validation_queue_event WHERE runId = 'old-run'"));
            assertThrows(SQLException.class, () -> execute(db,
                "DELETE FROM platform_validation_queue_event WHERE runId = 'old-run'"));
        }
    }

    private static void migrate(String url, String user, String password, String version) {
        Flyway.configure().dataSource(url, user, password).locations("classpath:db/migration")
            .baselineOnMigrate(true).baselineVersion("0").target(version).load().migrate();
    }

    private static void revision(Connection db, String sql, String id, long profile, long evidence) throws SQLException {
        try (PreparedStatement statement = db.prepareStatement(sql)) {
            statement.setString(1, id);
            statement.setLong(2, profile);
            statement.setLong(3, evidence);
            statement.executeUpdate();
        }
    }

    private static void insertEvent(Connection db, String sql, long id, String requestId) throws SQLException {
        try (PreparedStatement statement = db.prepareStatement(sql)) {
            statement.setLong(1, id);
            statement.setString(2, requestId);
            statement.executeUpdate();
        }
    }

    private static void execute(Connection db, String sql) throws SQLException {
        try (PreparedStatement statement = db.prepareStatement(sql)) {
            statement.executeUpdate();
        }
    }

    private static String scalar(Connection db, String sql) throws SQLException {
        try (PreparedStatement statement = db.prepareStatement(sql); ResultSet result = statement.executeQuery()) {
            result.next();
            return result.getString(1);
        }
    }
}
