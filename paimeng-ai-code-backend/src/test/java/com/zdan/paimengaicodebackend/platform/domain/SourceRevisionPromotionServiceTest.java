package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import org.mockito.ArgumentCaptor;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.*;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.*;
import com.zdan.paimengaicodebackend.platform.release.PlatformReleaseService;
import com.zdan.paimengaicodebackend.platform.snapshot.*;
import com.zdan.paimengaicodebackend.platform.validation.PlatformValidationQueueService;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class SourceRevisionPromotionServiceTest {
    private final AppMapper apps = mock(AppMapper.class);
    private final PlatformTaskMapper tasks = mock(PlatformTaskMapper.class);
    private final PlatformRunMapper runs = mock(PlatformRunMapper.class);
    private final CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
    private final ProfileDispositionMapper dispositions = mock(ProfileDispositionMapper.class);
    private final PlatformTrustedProfileVersionMapper profiles = mock(PlatformTrustedProfileVersionMapper.class);
    private final PlatformRequirementMapper requirements = mock(PlatformRequirementMapper.class);
    private final ValidationEvidenceMapper evidence = mock(ValidationEvidenceMapper.class);
    private final SourceRevisionMapper revisions = mock(SourceRevisionMapper.class);
    private final CandidateGitStore git = mock(CandidateGitStore.class);
    private final PlatformTaskTransitionService transitions = mock(PlatformTaskTransitionService.class);
    private final PlatformValidationQueueService validationQueue = mock(PlatformValidationQueueService.class);
    private final PlatformReleaseService releases = mock(PlatformReleaseService.class);
    private final SourceRevisionPromotionService service = new SourceRevisionPromotionService(
        apps, tasks, runs, snapshots, dispositions, profiles, requirements, evidence, revisions, git,
        transitions, validationQueue, releases, new ObjectMapper());
    private final String attempt = "11111111-2222-3333-4444-555555555555";
    private final Map<String, byte[]> artifacts = new HashMap<>();
    private final SnapshotReference ref = new SnapshotReference(1, 2, "run", CandidateGitStore.sha256("{}"), null,
        "b".repeat(40), "c".repeat(40));
    private final App app = new App();
    private final PlatformTask task = new PlatformTask();
    private final ProfileDisposition disposition = new ProfileDisposition();

    @BeforeEach
    void setup() {
        app.setId(1L);
        app.setLifecycleStatus("ACTIVE");
        app.setIsDelete(0);
        task.setId(2L);
        task.setApplicationId(1L);
        task.setState("EXECUTING");
        task.setBaseProfileVersion(3L);
        task.setRequirementId(9L);
        task.setBaselineJson("{}");
        disposition.setRunId("run");
        disposition.setApplicationId(1L);
        disposition.setTaskId(2L);
        disposition.setBaselineHash(ref.baselineHash());
        disposition.setCommitHash(ref.commitHash());
        disposition.setTreeHash(ref.treeHash());
        disposition.setReason("engineering change");
        disposition.setDisposition("unchanged");
        PlatformRun run = new PlatformRun();
        run.setId("run"); run.setApplicationId(1L); run.setTaskId(2L); run.setState("SUCCEEDED");
        CandidateSourceSnapshot snapshot = new CandidateSourceSnapshot();
        snapshot.setRunId("run"); snapshot.setApplicationId(1L); snapshot.setTaskId(2L);
        snapshot.setStatus("READY"); snapshot.setBaselineHash(ref.baselineHash());
        snapshot.setCommitHash(ref.commitHash()); snapshot.setTreeHash(ref.treeHash());
        PlatformTrustedProfileVersion profile = new PlatformTrustedProfileVersion();
        profile.setId(3L); profile.setApplicationId(1L); profile.setVersionNumber(1L);
        when(apps.lockApplication(1L)).thenReturn(1L);
        when(validationQueue.requirePassed(any())).thenReturn(attempt);
        when(apps.selectOneById(1L)).thenReturn(app);
        when(tasks.selectOneById(2L)).thenReturn(task);
        when(runs.selectOneById("run")).thenReturn(run);
        when(snapshots.requireReady(1, "run")).thenReturn(snapshot);
        when(dispositions.selectOneById("run")).thenReturn(disposition);
        when(profiles.selectOneById(3L)).thenReturn(profile);
        when(evidence.selectListByQuery(any())).thenReturn(List.of(
            pass("ENGINEERING", 11), pass("DATABASE", 12), pass("RUNTIME", 13),
            pass("TASK_ACCEPTANCE", 14)));
        try {
            when(git.readEvidence(any(), any())).thenAnswer(invocation -> {
                CandidateGitStore.ArtifactReference reference = invocation.getArgument(1);
                return artifacts.get(reference.sha256());
            });
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
        when(apps.updateByQuery(any(App.class), eq(true), any())).thenReturn(1);
        when(revisions.insert(any())).thenReturn(1);
        when(profiles.insert(any())).thenAnswer(invocation -> {
            PlatformTrustedProfileVersion row = invocation.getArgument(0);
            row.setId(4L);
            return 1;
        });
    }

    @Test
    void unchangedReusesProfileAndReplaysOnlySameStableIdentity() {
        SourceRevision created = service.promote(ref);
        assertEquals(3L, created.getProfileVersionId());
        verify(profiles, never()).insert(any());
        verify(transitions).transition(eq(2L), eq(PlatformTaskState.EXECUTING),
            eq(PlatformTaskState.VALIDATED), eq(PlatformActor.PLATFORM), any(), any(), any(), any());
        app.setStableSourceRevision(created.getId());
        when(revisions.selectOneByQuery(any())).thenReturn(created);
        assertEquals(created.getId(), service.promote(ref).getId());
        verify(revisions, times(1)).insert(any());
        assertThrows(BusinessException.class, () -> service.promote(new SnapshotReference(1, 2, "run",
            ref.baselineHash(), null, "d".repeat(40), ref.treeHash())));
    }

    @Test
    void changedRequiresCompleteStructuredDiffAndCreatesTrustedVersion() {
        disposition.setDisposition("changed");
        disposition.setRequirementId(9L);
        disposition.setDiffJson("{\"changes\":[{\"field\":\"name\"}],\"candidateProfile\":{\"name\":\"new\"}}");
        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setId(9L); requirement.setApplicationId(1L);
        when(requirements.selectOneById(9L)).thenReturn(requirement);
        PlatformTrustedProfileVersion baseProfile = profiles.selectOneById(3L);
        when(profiles.selectOneByQuery(any())).thenReturn(baseProfile);
        SourceRevision created = service.promote(ref);
        ArgumentCaptor<PlatformTrustedProfileVersion> promoted = ArgumentCaptor.forClass(
            PlatformTrustedProfileVersion.class);
        verify(profiles).insert(promoted.capture());
        assertEquals(1L, promoted.getValue().getApplicationId());
        assertEquals(2L, promoted.getValue().getVersionNumber());
        assertEquals("{\"name\":\"new\"}", promoted.getValue().getProfileJson());
        assertEquals(4L, created.getProfileVersionId());
    }

    @Test
    void snapshotMismatchCannotBePromotedEvenWithCompletePassingEvidence() {
        assertThrows(BusinessException.class, () -> service.promote(new SnapshotReference(1, 2, "run",
            ref.baselineHash(), null, "d".repeat(40), ref.treeHash())),
            "a reference naming another commit must not resolve to this Run's Snapshot");
        assertThrows(BusinessException.class, () -> service.promote(new SnapshotReference(1, 2, "run",
            ref.baselineHash(), null, ref.commitHash(), "d".repeat(40))),
            "a reference naming another tree must not resolve to this Run's Snapshot");
        assertThrows(BusinessException.class, () -> service.promote(new SnapshotReference(1, 9, "run",
            ref.baselineHash(), null, ref.commitHash(), ref.treeHash())),
            "a reference naming another task must not resolve to this Run's Snapshot");
        verify(revisions, never()).insert(any());
        verify(transitions, never()).transition(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void failedOrNonPlatformIssuedEvidenceCannotBePromoted() {
        List<ValidationEvidence> complete = List.of(pass("ENGINEERING", 11), pass("DATABASE", 12),
            pass("RUNTIME", 13), pass("TASK_ACCEPTANCE", 14));
        ValidationEvidence failed = evidence("RUNTIME", 13, "FAIL", "PLATFORM_VALIDATOR_V1", attempt);
        when(evidence.selectListByQuery(any())).thenReturn(List.of(
            pass("ENGINEERING", 11), pass("DATABASE", 12), failed, pass("TASK_ACCEPTANCE", 14)));
        assertThrows(BusinessException.class, () -> service.promote(ref),
            "a failed gate result must block the whole promotion");
        ValidationEvidence legacy = evidence("TASK_ACCEPTANCE", 14, "PASS", "LEGACY", "LEGACY");
        when(evidence.selectListByQuery(any())).thenReturn(List.of(
            pass("ENGINEERING", 11), pass("DATABASE", 12), pass("RUNTIME", 13), legacy));
        assertThrows(BusinessException.class, () -> service.promote(ref),
            "evidence not issued by the Platform validator must never be promotable");
        ValidationEvidence foreignAttempt = evidence("DATABASE", 12, "PASS", "PLATFORM_VALIDATOR_V1",
            "99999999-8888-7777-6666-555555555555");
        when(evidence.selectListByQuery(any())).thenReturn(List.of(
            pass("ENGINEERING", 11), foreignAttempt, pass("RUNTIME", 13), pass("TASK_ACCEPTANCE", 14)));
        assertThrows(BusinessException.class, () -> service.promote(ref),
            "all four results must come from the same authoritative attempt");
        when(evidence.selectListByQuery(any())).thenReturn(complete);
        verify(revisions, never()).insert(any());
        verify(profiles, never()).insert(any());
        verify(transitions, never()).transition(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void rejectsLegacyDiffMissingEvidenceAndStaleBaseline() {
        disposition.setDisposition("changed"); disposition.setRequirementId(9L);
        disposition.setDiffJson("{\"changes\":[1]}");
        assertThrows(BusinessException.class, () -> service.promote(ref));
        disposition.setDisposition("unchanged");
        when(evidence.selectListByQuery(any())).thenReturn(List.of(pass("ENGINEERING", 11)));
        assertThrows(BusinessException.class, () -> service.promote(ref));
        when(evidence.selectListByQuery(any())).thenReturn(List.of(pass("ENGINEERING", 11),
            pass("DATABASE", 12), pass("RUNTIME", 13), pass("TASK_ACCEPTANCE", 14)));
        app.setStableSourceRevision("other");
        assertThrows(BusinessException.class, () -> service.promote(ref));
        verify(revisions, never()).insert(any());
        verify(profiles, never()).insert(any());
        verify(transitions, never()).transition(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void rejectsUncertainForeignProfileDuplicatePassAndFailedCas() {
        disposition.setDisposition("uncertain");
        assertThrows(BusinessException.class, () -> service.promote(ref));
        disposition.setDisposition("unchanged");
        PlatformTrustedProfileVersion foreign = new PlatformTrustedProfileVersion();
        foreign.setId(3L); foreign.setApplicationId(99L);
        when(profiles.selectOneById(3L)).thenReturn(foreign);
        assertThrows(BusinessException.class, () -> service.promote(ref));
        foreign.setApplicationId(1L);
        ValidationEvidence repeated = pass("ENGINEERING", 15);
        when(evidence.selectListByQuery(any())).thenReturn(List.of(pass("ENGINEERING", 11), repeated,
            pass("DATABASE", 12), pass("RUNTIME", 13), pass("TASK_ACCEPTANCE", 14)));
        assertThrows(BusinessException.class, () -> service.promote(ref));
        when(evidence.selectListByQuery(any())).thenReturn(List.of(pass("ENGINEERING", 11),
            pass("DATABASE", 12), pass("RUNTIME", 13), pass("TASK_ACCEPTANCE", 14)));
        when(apps.updateByQuery(any(App.class), eq(true), any())).thenReturn(0);
        assertThrows(BusinessException.class, () -> service.promote(ref));
        verify(profiles, never()).insert(any());
    }

    @Test
    void rejectsUnrecoverableEvidenceAndMalformedProfile() throws Exception {
        doThrow(new java.io.IOException("missing artifact")).when(git).readEvidence(any(), any());
        assertThrows(BusinessException.class, () -> service.promote(ref));
        doAnswer(invocation -> {
            CandidateGitStore.ArtifactReference reference = invocation.getArgument(1);
            return artifacts.get(reference.sha256());
        }).when(git).readEvidence(any(), any());
        disposition.setDisposition("changed");
        disposition.setRequirementId(9L);
        disposition.setDiffJson("{\"candidateProfile\":{},\"changes\":[1]}");
        assertThrows(BusinessException.class, () -> service.promote(ref));
        verify(revisions, never()).insert(any());
        verify(profiles, never()).insert(any());
        verify(transitions, never()).transition(any(), any(), any(), any(), any(), any(), any(), any());
    }

    private ValidationEvidence pass(String category, long id) {
        return evidence(category, id, "PASS", "PLATFORM_VALIDATOR_V1", attempt);
    }

    /** Builds a row the Platform validator could not have produced, so promotion must refuse it. */
    private ValidationEvidence evidence(String category, long id, String result, String issuer, String attemptId) {
        ValidationEvidence row = new ValidationEvidence();
        row.setId(id); row.setApplicationId(1L); row.setTaskId(2L); row.setRunId("run");
        row.setBaselineHash(ref.baselineHash()); row.setCommitHash(ref.commitHash());
        row.setTreeHash(ref.treeHash()); row.setCategory(category); row.setResult(result);
        row.setIssuer(issuer); row.setAttemptId(attemptId);
        row.setIdempotencyKey(attemptId + ":" + category);
        String payload = "{\"schemaVersion\":1,\"category\":\"" + category
            + "\",\"status\":\"" + result + "\",\"reasonCode\":\"" + result + "\"}";
        row.setPayloadJson(payload);
        row.setArtifactRef("refs/evidence/" + "a".repeat(64));
        row.setArtifactCommitHash("b".repeat(40));
        row.setArtifactSha256(CandidateGitStore.sha256(payload));
        artifacts.put(row.getArtifactSha256(), payload.getBytes(StandardCharsets.UTF_8));
        return row;
    }
}
