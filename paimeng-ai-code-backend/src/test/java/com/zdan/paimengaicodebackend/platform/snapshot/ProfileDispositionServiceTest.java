package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ProfileDispositionServiceTest {
    @Mock CandidateSnapshotService snapshots;
    @Mock CandidateSourceSnapshotMapper snapshotMapper;
    @Mock PlatformRequirementMapper requirements;
    @Mock ProfileDispositionMapper dispositions;
    private ProfileDispositionService service;
    private final SnapshotReference ref = new SnapshotReference(1, 2, "run-1", "baseline", null, "commit", "tree");

    @BeforeEach
    void setup() {
        service = new ProfileDispositionService(snapshots, snapshotMapper, requirements, dispositions,
            new ObjectMapper());
    }

    private void ready() {
        CandidateSourceSnapshot snapshot = new CandidateSourceSnapshot();
        snapshot.setApplicationId(1L);
        snapshot.setTaskId(2L);
        snapshot.setRunId("run-1");
        snapshot.setBaselineHash("baseline");
        snapshot.setCommitHash("commit");
        snapshot.setTreeHash("tree");
        when(snapshotMapper.lockRun("run-1")).thenReturn("run-1");
        when(snapshots.requireReady(1, "run-1")).thenReturn(snapshot);
    }

    @Test
    void changedRequiresStructuredDiffAndSameApplicationRequirement() {
        ready();
        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(1L);
        when(requirements.selectOneById(3L)).thenReturn(requirement);
        assertThrows(BusinessException.class, () -> service.record(ref, "changed", "{}", 3L, "changed scope"));
        assertThrows(BusinessException.class, () -> service.record(ref, "changed", "\"string\"", 3L, "changed scope"));
        assertThrows(BusinessException.class, () -> service.record(ref, "changed", "{invalid", 3L, "changed scope"));
        ProfileDisposition row = service.record(ref, "changed", "{\"add\":[\"x\"]}", 3L, "changed scope");
        assertEquals("{\"add\":[\"x\"]}", row.getDiffJson());
        assertEquals(3L, row.getRequirementId());
        verify(dispositions).insert(row);
    }

    @Test
    void foreignRequirementAndInvalidDispositionNeverPersist() {
        ready();
        PlatformRequirement foreign = new PlatformRequirement();
        foreign.setApplicationId(9L);
        when(requirements.selectOneById(3L)).thenReturn(foreign);
        assertThrows(BusinessException.class, () -> service.record(ref, "changed", "[1]", 3L, "reason"));
        assertThrows(BusinessException.class, () -> service.record(ref, "unknown", null, null, "reason"));
        assertThrows(BusinessException.class, () -> service.record(ref, "unchanged", "[1]", null, "reason"));
        assertThrows(BusinessException.class, () -> service.record(ref, "uncertain", null, null, " "));
        verify(dispositions, never()).insert(any());
    }

    @Test
    void unchangedAndUncertainRequireReasonButForbidDiffOrRequirement() {
        ready();
        assertThrows(BusinessException.class, () -> service.record(ref, "unchanged", null, 3L, "reason"));
        assertThrows(BusinessException.class, () -> service.record(ref, "uncertain", "[]", null, "reason"));
        ProfileDisposition row = service.record(ref, "uncertain", null, null, "needs review");
        assertEquals("uncertain", row.getDisposition());
        assertEquals("needs review", row.getReason());
    }

    @Test
    void onceRecordedOnlyExactReplayIsAccepted() {
        ready();
        ProfileDisposition existing = service.record(ref, "unchanged", null, null, "reviewed");
        when(dispositions.selectOneById("run-1")).thenReturn(existing);
        assertEquals(existing, service.record(ref, "unchanged", null, null, "reviewed"));
        assertThrows(BusinessException.class, () -> service.record(ref, "unchanged", null, null, "different"));
        verify(dispositions).insert(existing);
    }

    @Test
    void mismatchedTrustedIdentityIsRejected() {
        ready();
        assertThrows(BusinessException.class, () -> service.record(
            new SnapshotReference(1, 9, "run-1", "baseline", null, "commit", "tree"),
            "unchanged", null, null, "reason"));
        verify(dispositions, never()).insert(any());
    }
}
