package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest
@Transactional
class SnapshotEvidenceDatabaseIntegrationTest {
    @Autowired private JdbcTemplate jdbc;

    private long appId;
    private long taskId;
    private String runId;
    private static final String BASELINE = "a".repeat(64);
    private static final String COMMIT = "b".repeat(40);
    private static final String TREE = "c".repeat(40);

    @BeforeEach
    void createSyntheticRun() {
        appId = UUID.randomUUID().getMostSignificantBits() & Long.MAX_VALUE;
        taskId = appId + 1;
        runId = "run-" + UUID.randomUUID();
        jdbc.update("INSERT INTO app (id, userId, appName) VALUES (?, ?, ?)", appId, 1, "isolated-test");
        jdbc.update("INSERT INTO platform_requirement (id, appId, kind, originalText) VALUES (?, ?, ?, ?)",
            appId + 2, appId, "OWNER", "synthetic requirement");
        jdbc.update("INSERT INTO platform_task (id, appId, requirementId, state) VALUES (?, ?, ?, ?)",
            taskId, appId, appId + 2, "EXECUTING");
        jdbc.update("INSERT INTO platform_run (id, appId, taskId, state, attemptNumber) VALUES (?, ?, ?, ?, ?)",
            runId, appId, taskId, "SUCCEEDED", 1);
        jdbc.update("INSERT INTO platform_candidate_source_snapshot "
                + "(runId, appId, taskId, requestId, fenceToken, baselineHash, baseSourceRevision, status, commitHash, treeHash) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            runId, appId, taskId, "freeze", 1, BASELINE, null, "READY", COMMIT, TREE);
    }

    @Test
    void acceptsMatchingNullableRevisionAndRejectsIdentityAliases() {
        profile(runId, BASELINE, null, "unchanged");
        evidence(runId, BASELINE, null, "PASS", "key");
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM platform_validation_evidence WHERE runId = ?",
            Integer.class, runId));

        assertThrows(DataAccessException.class, () -> profile(runId.toUpperCase(), BASELINE, null, "unchanged"));
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE.toUpperCase(), null, "FAIL", "other"));
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE, "other-revision", "FAIL", "other"));
        assertThrows(DataAccessException.class, () -> evidence(runId + " ", BASELINE, null, "FAIL", "other"));
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE, null, "FAIL", "KEY"));
    }

    @Test
    void rejectsEnumAliasesUncertainPassAndFailedRun() {
        assertThrows(DataAccessException.class, () -> profile(runId, BASELINE, null, "Uncertain"));
        profile(runId, BASELINE, null, "uncertain");
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE, null, "PASS", "pass"));
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE, null, "pass", "pass"));
        evidence(runId, BASELINE, null, "FAIL", "failure");
        jdbc.update("UPDATE platform_run SET state = 'FAILED' WHERE id = ?", runId);
        assertThrows(DataAccessException.class, () -> evidence(runId, BASELINE, null, "FAIL", "later"));
    }

    @Test
    void readySnapshotAndEvidenceAreImmutable() {
        profile(runId, BASELINE, null, "unchanged");
        evidence(runId, BASELINE, null, "PASS", "key");
        assertThrows(DataAccessException.class, () -> jdbc.update(
            "UPDATE platform_candidate_source_snapshot SET status = 'FREEZING' WHERE runId = ?", runId));
        assertThrows(DataAccessException.class, () -> jdbc.update(
            "UPDATE platform_profile_disposition SET reason = 'changed' WHERE runId = ?", runId));
        assertThrows(DataAccessException.class, () -> jdbc.update(
            "DELETE FROM platform_validation_evidence WHERE runId = ?", runId));
    }

    private void profile(String id, String baseline, String revision, String disposition) {
        jdbc.update("INSERT INTO platform_profile_disposition "
                + "(runId, appId, taskId, baselineHash, baseSourceRevision, commitHash, treeHash, disposition, reason) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, appId, taskId, baseline, revision, COMMIT, TREE, disposition, "synthetic reason");
    }

    private void evidence(String id, String baseline, String revision, String result, String key) {
        String payload = "{\"ok\":true}";
        jdbc.update("INSERT INTO platform_validation_evidence "
                + "(id, appId, taskId, runId, baselineHash, baseSourceRevision, commitHash, treeHash, "
                + "category, result, payloadJson, payloadSha256, artifactRef, artifactCommitHash, artifactSha256, idempotencyKey) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, SHA2(?, 256), ?, ?, ?, ?)",
            UUID.randomUUID().getMostSignificantBits() & Long.MAX_VALUE, appId, taskId, id, baseline,
            revision, COMMIT, TREE, "BUILD", result, payload, payload,
            "refs/evidence/" + "d".repeat(64), "e".repeat(40), "f".repeat(64), key);
    }
}
