package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunProgressService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.domain.SourceRevisionPromotionService;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import com.zdan.paimengaicodebackend.platform.snapshot.ValidationEvidenceService;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * 权威验证如何改变 Task 状态（Issue #80 / T-08）
 *
 * <p>AD-009 把「开发完成」的裁决权放在 Platform。这里断言的是裁决逻辑本身：四类门禁必须
 * 全部 {@code PASS} 且 Profile 申报不是 {@code uncertain} 才允许晋升，否则 Task 落
 * {@code failed} 且基线保留。门禁本身需要 Docker 与隔离 MySQL，由 #79 的测试覆盖。
 */
class PlatformValidationWorkerTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long TASK_ID = 460017668615995394L;
    private static final String RUN_ID = "run-7001";
    private static final String BASELINE_HASH = "a".repeat(64);
    private static final String COMMIT_HASH = "b".repeat(40);
    private static final String TREE_HASH = "c".repeat(40);
    private static final String ATTEMPT_ID = "1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64";

    private final PlatformValidationQueueService validationQueue = mock(PlatformValidationQueueService.class);
    private final SnapshotProfileDeclarationService profileDeclarations = mock(SnapshotProfileDeclarationService.class);
    private final CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
    private final CandidateValidationGateRunner gateRunner = mock(CandidateValidationGateRunner.class);
    private final ValidationEvidenceService evidenceService = mock(ValidationEvidenceService.class);
    private final CandidateGitStore git = mock(CandidateGitStore.class);
    private final SourceRevisionPromotionService promotion = mock(SourceRevisionPromotionService.class);
    private final PlatformTaskLifecycleService lifecycle = mock(PlatformTaskLifecycleService.class);
    private final PlatformRunProgressService progress = mock(PlatformRunProgressService.class);
    private final PlatformRunMapper runMapper = mock(PlatformRunMapper.class);
    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);

    private PlatformValidationWorker worker;

    @BeforeEach
    void setUp() throws Exception {
        worker = new PlatformValidationWorker(validationQueue, profileDeclarations, snapshots, gateRunner,
            evidenceService, git, promotion, lifecycle, progress, runMapper, taskMapper);
        when(validationQueue.claimNext()).thenReturn(Optional.of(
            new PlatformValidationQueueService.Claim(1L, APPLICATION_ID, RUN_ID, ATTEMPT_ID, null)));
        when(runMapper.selectOneById(RUN_ID)).thenReturn(run());
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(task());
        when(snapshots.requireReady(APPLICATION_ID, RUN_ID)).thenReturn(snapshot());
        when(profileDeclarations.declare(any())).thenReturn(disposition("unchanged"));
        when(gateRunner.validate(any(), anyString())).thenReturn(passingReport());
        when(git.persistEvidence(any(), anyString(), any()))
            .thenReturn(new CandidateGitStore.ArtifactReference("refs/evidence/x", COMMIT_HASH, "d".repeat(64)));
    }

    @Test
    void emptyQueueIsIdleNotAnError() {
        when(validationQueue.claimNext()).thenReturn(Optional.empty());

        assertTrue(worker.settleNext().isEmpty());
        verify(lifecycle, never()).markFailed(any(), any(), any(), any(), any());
    }

    @Test
    void allFourGatesPassingPromotesTheExactSameSnapshot() {
        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("PASS", outcome.state());
        assertEquals("ALL_GATES_PASSED", outcome.reasonCode());
        // 晋升必须绑定同一 Snapshot：Agent 自述的引用不会被采纳。
        ArgumentCaptor<SnapshotReference> promoted = ArgumentCaptor.forClass(SnapshotReference.class);
        verify(promotion).promote(promoted.capture());
        assertEquals(RUN_ID, promoted.getValue().runId());
        assertEquals(COMMIT_HASH, promoted.getValue().commitHash());
        assertEquals(TREE_HASH, promoted.getValue().treeHash());
        verify(validationQueue).complete(any(), eq("PASS"), eq("ALL_GATES_PASSED"));
        verify(lifecycle, never()).markFailed(any(), any(), any(), any(), any());
    }

    @Test
    void eachGateGetsExactlyOneEvidenceRecordBoundToTheSameAttempt() {
        worker.settleNext().orElseThrow();

        for (String category : List.of("ENGINEERING", "DATABASE", "RUNTIME", "TASK_ACCEPTANCE")) {
            verify(evidenceService).recordValidated(any(), eq(category), eq("PASS"),
                anyString(), any(), eq(ATTEMPT_ID));
        }
    }

    @Test
    void oneFailingGateFailsTheTaskAndNeverPromotes() {
        when(gateRunner.validate(any(), anyString())).thenReturn(new CandidateFourGateExecutor.Report(
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.FAIL, "MIGRATION_UNSAFE"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS")));

        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("FAIL", outcome.state());
        assertEquals("MIGRATION_UNSAFE", outcome.reasonCode());
        verify(validationQueue).complete(any(), eq("FAIL"), eq("MIGRATION_UNSAFE"));
        verify(promotion, never()).promote(any());
        verify(lifecycle).markFailed(eq(TASK_ID), eq("VALIDATION_FAILED"), eq("MIGRATION_UNSAFE"),
            eq(COMMIT_HASH), anyString());
        verify(progress).record(APPLICATION_ID, TASK_ID, RUN_ID, PlatformProgressStage.VALIDATION_FAILED, null);
    }

    @Test
    void uncertainProfileDispositionBlocksPromotionEvenWhenEveryGatePasses() {
        when(profileDeclarations.declare(any())).thenReturn(disposition("uncertain"));

        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("FAIL", outcome.state());
        assertEquals("PROFILE_DISPOSITION_UNCERTAIN", outcome.reasonCode());
        // 不确定的申报下不允许留下任何 PASS 痕迹，否则计数闸门会被欺骗。
        verify(evidenceService, never()).recordValidated(any(), anyString(), eq("PASS"), anyString(), any(), anyString());
        verify(promotion, never()).promote(any());
    }

    @Test
    void brokenEvidenceChainSettlesInconclusiveInsteadOfSilentlyPassing() {
        when(gateRunner.validate(any(), anyString()))
            .thenThrow(new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot 文件不可恢复"));

        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("INCONCLUSIVE", outcome.state());
        assertEquals("EVIDENCE_CHAIN_INCOMPLETE", outcome.reasonCode());
        verify(validationQueue).complete(any(), eq("INCONCLUSIVE"), eq("EVIDENCE_CHAIN_INCOMPLETE"));
        verify(promotion, never()).promote(any());
        verify(lifecycle).markFailed(eq(TASK_ID), eq("VALIDATION_INCONCLUSIVE"), eq("EVIDENCE_CHAIN_INCOMPLETE"),
            eq(COMMIT_HASH), anyString());
    }

    @Test
    void missingAcceptanceTargetCannotReachAValidationVerdict() {
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(taskWithoutAcceptanceTarget());

        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("INCONCLUSIVE", outcome.state());
        assertEquals("ACCEPTANCE_TARGET_MISSING", outcome.reasonCode());
        verify(gateRunner, never()).validate(any(), anyString());
    }

    @Test
    void snapshotBelongingToAnotherTaskIsRejectedBeforeGatesRun() {
        CandidateSourceSnapshot foreign = snapshot();
        foreign.setTaskId(TASK_ID + 1);
        when(snapshots.requireReady(APPLICATION_ID, RUN_ID)).thenReturn(foreign);

        PlatformValidationWorker.Outcome outcome = worker.settleNext().orElseThrow();

        assertEquals("INCONCLUSIVE", outcome.state());
        verify(gateRunner, never()).validate(any(), anyString());
    }

    private PlatformRun run() {
        PlatformRun run = new PlatformRun();
        run.setId(RUN_ID);
        run.setApplicationId(APPLICATION_ID);
        run.setTaskId(TASK_ID);
        run.setState("SUCCEEDED");
        return run;
    }

    private PlatformTask task() {
        PlatformTask task = new PlatformTask();
        task.setId(TASK_ID);
        task.setApplicationId(APPLICATION_ID);
        task.setState("EXECUTING");
        task.setAcceptanceTarget("An owner can book an appointment up to 14 days ahead");
        return task;
    }

    private PlatformTask taskWithoutAcceptanceTarget() {
        PlatformTask task = task();
        task.setAcceptanceTarget("   ");
        return task;
    }

    private CandidateSourceSnapshot snapshot() {
        CandidateSourceSnapshot snapshot = new CandidateSourceSnapshot();
        snapshot.setApplicationId(APPLICATION_ID);
        snapshot.setTaskId(TASK_ID);
        snapshot.setRunId(RUN_ID);
        snapshot.setBaselineHash(BASELINE_HASH);
        snapshot.setCommitHash(COMMIT_HASH);
        snapshot.setTreeHash(TREE_HASH);
        return snapshot;
    }

    private ProfileDisposition disposition(String value) {
        ProfileDisposition disposition = new ProfileDisposition();
        disposition.setRunId(RUN_ID);
        disposition.setDisposition(value);
        return disposition;
    }

    private CandidateFourGateExecutor.Report passingReport() {
        return new CandidateFourGateExecutor.Report(
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"),
            new CandidateFourGateExecutor.Gate(CandidateFourGateExecutor.Status.PASS, "PASS"));
    }
}
