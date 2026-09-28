package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ValidationEvidenceMapper;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.entity.ValidationEvidence;
import java.io.IOException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ValidationEvidenceServiceTest {
    @Mock CandidateSnapshotService snapshots;
    @Mock CandidateSourceSnapshotMapper snapshotMapper;
    @Mock PlatformRunMapper runs;
    @Mock ProfileDispositionMapper dispositions;
    @Mock ValidationEvidenceMapper evidence;
    @Mock CandidateGitStore git;
    private ValidationEvidenceService service;
    private final SnapshotReference ref = new SnapshotReference(1, 2, "run-1", "baseline", null, "commit", "tree");
    private final CandidateGitStore.ArtifactReference artifact = new CandidateGitStore.ArtifactReference(
        "refs/evidence/" + "a".repeat(64), "b".repeat(40), "c".repeat(64));

    @BeforeEach
    void setup() {
        service = new ValidationEvidenceService(snapshots, snapshotMapper, runs, dispositions, evidence,
            new ObjectMapper(), git);
    }

    private void ready(String runState, String disposition) {
        when(snapshotMapper.lockRun("run-1")).thenReturn("run-1");
        PlatformRun run = new PlatformRun();
        run.setId("run-1");
        run.setApplicationId(1L);
        run.setTaskId(2L);
        run.setState(runState);
        when(runs.selectOneById("run-1")).thenReturn(run);
        if (!"SUCCEEDED".equals(runState)) return;
        CandidateSourceSnapshot snapshot = new CandidateSourceSnapshot();
        snapshot.setRunId("run-1");
        snapshot.setApplicationId(1L);
        snapshot.setTaskId(2L);
        snapshot.setBaselineHash("baseline");
        snapshot.setCommitHash("commit");
        snapshot.setTreeHash("tree");
        when(snapshots.requireReady(1, "run-1")).thenReturn(snapshot);
        ProfileDisposition profile = new ProfileDisposition();
        profile.setRunId("run-1");
        profile.setApplicationId(1L);
        profile.setTaskId(2L);
        profile.setBaselineHash("baseline");
        profile.setCommitHash("commit");
        profile.setTreeHash("tree");
        profile.setDisposition(disposition);
        when(dispositions.selectOneById("run-1")).thenReturn(profile);
    }

    @Test
    void readySnapshotWhoseRunFailedCannotRecordPassOrAnyValidation() {
        ready("FAILED", "unchanged");
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"ok\":true}", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "FAIL", "{\"ok\":false}", artifact, "key"));
        verify(evidence, never()).insert(any());
    }

    @Test
    void uncertainForbidsPassButRetainsFailureEvidence() {
        ready("SUCCEEDED", "uncertain");
        assertThrows(BusinessException.class, () -> service.record(ref, "TEST", "PASS", "{\"ok\":true}", artifact, "key"));
        ValidationEvidence row = service.record(ref, "TEST", "FAIL", "{\"ok\":false}", artifact, "key");
        assertEquals("FAIL", row.getResult());
        verify(evidence).insert(row);
    }

    @Test
    void evidenceIsBoundedHasDigestAndRejectsConflictingReplay() {
        ready("SUCCEEDED", "changed");
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "[]", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS",
            "{\"ok\":true}{\"hidden\":true}", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"data\":\"" + "x".repeat(65536) + "\"}", artifact, "key"));
        ValidationEvidence row = service.record(ref, "BUILD", "PASS", "{\"ok\":true}", artifact, "key");
        assertEquals("4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93", row.getPayloadSha256());
        assertEquals("{\"ok\":true}", row.getPayloadJson());
        assertEquals(artifact.ref(), row.getArtifactRef());
        assertEquals(artifact.commitHash(), row.getArtifactCommitHash());
        assertEquals(artifact.sha256(), row.getArtifactSha256());
        when(evidence.selectOneByQuery(any())).thenReturn(row);
        assertEquals(row, service.record(ref, "BUILD", "PASS", " { \"ok\" : true } ", artifact, "key"));
        assertEquals(row, service.record(ref, "BUILD", "PASS", "{\"ok\":true}", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "FAIL", "{\"ok\":true}", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"ok\":false}", artifact, "key"));
        row.setIdempotencyKey("Key");
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"ok\":true}", artifact, "key"));
        row.setIdempotencyKey("key ");
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"ok\":true}", artifact, "key"));
        row.setIdempotencyKey("key");
        assertThrows(BusinessException.class, () -> service.record(ref, "BUILD", "PASS", "{\"ok\":true}",
            new CandidateGitStore.ArtifactReference(artifact.ref(), artifact.commitHash(), "d".repeat(64)), "key"));
        verify(evidence).insert(row);
    }

    @Test
    void missingOrForeignArtifactCannotBeRecorded() throws IOException {
        ready("SUCCEEDED", "unchanged");
        assertThrows(BusinessException.class, () -> service.record(ref, "TEST", "PASS", "{\"ok\":true}", null, "key"));
        org.mockito.Mockito.doThrow(new BusinessException(ErrorCode.FORBIDDEN_ERROR, "foreign artifact"))
            .when(git).verifyEvidence(ref, artifact);
        assertThrows(BusinessException.class, () -> service.record(ref, "TEST", "PASS", "{\"ok\":true}", artifact, "key"));
        verify(evidence, never()).insert(any());
    }

    @Test
    void succeededRunWithDifferentOwnerIsRejectedBeforeEvidenceWrite() {
        when(snapshotMapper.lockRun("run-1")).thenReturn("run-1");
        PlatformRun run = new PlatformRun();
        run.setApplicationId(9L);
        run.setTaskId(2L);
        run.setState("SUCCEEDED");
        when(runs.selectOneById("run-1")).thenReturn(run);
        assertThrows(BusinessException.class, () -> service.record(ref, "TEST", "PASS", "{\"ok\":true}", artifact, "key"));
        verify(evidence, never()).insert(any());
    }

    @Test
    void wrongSnapshotIdentityAndInvalidCategoryAreRejected() {
        ready("SUCCEEDED", "unchanged");
        assertThrows(BusinessException.class, () -> service.record(
            new SnapshotReference(1, 2, "run-1", "baseline", null, "other", "tree"),
            "TEST", "PASS", "{\"ok\":true}", artifact, "key"));
        assertThrows(BusinessException.class, () -> service.record(ref, "free-form", "PASS", "{\"ok\":true}", artifact, "key"));
        verify(evidence, never()).insert(any());
    }
}
