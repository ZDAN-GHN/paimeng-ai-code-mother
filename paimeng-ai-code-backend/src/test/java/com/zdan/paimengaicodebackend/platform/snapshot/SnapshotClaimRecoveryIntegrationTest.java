package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@SpringBootTest
@Transactional
class SnapshotClaimRecoveryIntegrationTest {
    @Autowired private JdbcTemplate jdbc;
    @Autowired private PlatformRunLeaseService leases;
    @Autowired private SnapshotClaims claims;
    @Autowired private CandidateSourceSnapshotMapper snapshots;
    @Autowired private PlatformTaskMapper tasks;
    @Autowired private PlatformTransactionManager transactionManager;
    @TempDir Path privateRoot;

    private long appId;
    private String runId;
    private PlatformTask task;
    private String baselineHash;

    @AfterEach
    void cleanCommittedFixture() {
        if (org.springframework.test.context.transaction.TestTransaction.isActive()) return;
        Long fence = jdbc.query("SELECT fenceToken FROM platform_run_lease WHERE runId = ?",
            rs -> rs.next() ? rs.getLong(1) : null, runId);
        if (fence != null) {
            leases.release(runId, fence, PlatformActor.PLATFORM, "SYNTHETIC_TEST_CLEANUP", "cleanup-lease");
        }
        jdbc.update("UPDATE platform_run SET state = 'FAILED' WHERE id = ? AND state = 'EXECUTING'", runId);
        jdbc.update("UPDATE app SET isDelete = 1 WHERE id = ?", appId);
    }

    @BeforeEach
    void createRun() throws IOException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        appId = UUID.randomUUID().getMostSignificantBits() & Long.MAX_VALUE;
        long taskId = appId + 1;
        runId = "run-" + UUID.randomUUID();
        jdbc.update("INSERT INTO app (id, userId, appName) VALUES (?, ?, ?)", appId, 1, "isolated-test");
        jdbc.update("INSERT INTO platform_requirement (id, appId, kind, originalText) VALUES (?, ?, ?, ?)",
            appId + 2, appId, "OWNER", "synthetic requirement");
        jdbc.update("INSERT INTO platform_task (id, appId, requirementId, state, baselineJson) "
            + "VALUES (?, ?, ?, ?, ?)", taskId, appId, appId + 2, "EXECUTING", "{\"schemaVersion\":1}");
        jdbc.update("INSERT INTO platform_run (id, appId, taskId, state, attemptNumber) VALUES (?, ?, ?, ?, ?)",
            runId, appId, taskId, "EXECUTING", 1);
        task = tasks.selectOneById(taskId);
        baselineHash = CandidateGitStore.sha256(task.getBaselineJson());
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void gitObjectSurvivesFailedFinishAndNewFenceCanSafelyReuseIt() throws IOException {
        long firstFence = leases.grant(runId, PlatformActor.RUNTIME, "RUN_STARTED", "grant-1")
            .getFenceToken();
        var original = claims.claim(appId, runId, firstFence, "freeze-1", task, baselineHash);
        assertThrows(BusinessException.class,
            () -> claims.claim(appId, runId, firstFence, "freeze-1", task, baselineHash));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("source.txt"), "frozen");
        var persisted = git.commit(appId, runId, baselineHash, stage);

        leases.release(runId, firstFence, PlatformActor.RUNTIME, "RETRY", "release-1");
        long newFence = leases.grant(runId, PlatformActor.RUNTIME, "RUN_STARTED", "grant-2")
            .getFenceToken();
        assertEquals(firstFence + 1, newFence);
        assertThrows(BusinessException.class, () -> claims.finish(original,
            persisted.commitHash(), persisted.treeHash()));

        var recovered = claims.claim(appId, runId, newFence, "freeze-2", task, baselineHash);
        claims.abort(original);
        assertEquals("FREEZING", snapshots.selectOneById(runId).getStatus());
        assertEquals(persisted, git.commit(appId, runId, baselineHash, stage));
        claims.finish(recovered, persisted.commitHash(), persisted.treeHash());
        assertEquals("READY", snapshots.selectOneById(runId).getStatus());
        assertEquals(persisted.commitHash(), snapshots.selectOneById(runId).getCommitHash());
    }

    @Test
    void abortedClaimAllowsNewRequestWithSameFenceButNotAnActiveReplay() {
        long fence = leases.grant(runId, PlatformActor.RUNTIME, "RUN_STARTED", "grant-1")
            .getFenceToken();
        var original = claims.claim(appId, runId, fence, "freeze-1", task, baselineHash);
        claims.abort(original);
        assertEquals("ABORTED", snapshots.selectOneById(runId).getStatus());
        var retried = claims.claim(appId, runId, fence, "freeze-2", task, baselineHash);
        assertEquals("FREEZING", snapshots.selectOneById(runId).getStatus());
        assertEquals("freeze-2", retried.getRequestId());
        claims.abort(original);
        assertEquals("FREEZING", snapshots.selectOneById(runId).getStatus());
    }

    @Test
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    void newFenceCannotPassAnUncommittedSnapshotPublication() throws Exception {
        long fence = leases.grant(runId, PlatformActor.RUNTIME, "RUN_STARTED", "grant-1")
            .getFenceToken();
        var claimed = claims.claim(appId, runId, fence, "freeze-1", task, baselineHash);
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch publish = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var first = workers.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    claims.finish(claimed, "a".repeat(40), "b".repeat(40));
                    locked.countDown();
                    try {
                        if (!publish.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("publish timed out");
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(e);
                    }
                });
                return null;
            });
            try {
                if (!locked.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("lease lock timed out");
                var next = workers.submit(() -> {
                    leases.release(runId, fence, PlatformActor.RUNTIME, "RETRY", "release-1");
                    return leases.grant(runId, PlatformActor.RUNTIME, "RUN_STARTED", "grant-2")
                        .getFenceToken();
                });
                assertThrows(TimeoutException.class, () -> next.get(250, TimeUnit.MILLISECONDS));
                publish.countDown();
                first.get(10, TimeUnit.SECONDS);
                assertEquals(fence + 1, next.get(10, TimeUnit.SECONDS));
                assertEquals("READY", snapshots.selectOneById(runId).getStatus());
            } finally {
                publish.countDown();
            }
        }
    }
}
