package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.ProfileDispositionService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SnapshotProfileDeclarationServiceTest {
    @TempDir Path root;
    private final CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
    private final ProfileDispositionService dispositions = mock(ProfileDispositionService.class);

    @Test
    void recordsExplicitDeclarationBoundToFrozenTree() throws Exception {
        var fixture = snapshot("{\"disposition\":\"unchanged\",\"reason\":\"Engineering only\"}");
        fixture.service().declare(fixture.reference());
        verify(dispositions).record(fixture.reference(), "unchanged", null, null, "Engineering only");
    }

    @Test
    void rejectsAbsentOrLegacyDiffWithoutProfile() throws Exception {
        var missing = snapshot(null);
        assertThrows(BusinessException.class, () -> missing.service().declare(missing.reference()));
        var incomplete = snapshot("{\"disposition\":\"changed\",\"reason\":\"New field\","
            + "\"requirementId\":42,\"diff\":{\"changes\":[{\"path\":\"/x\"}]}}");
        assertThrows(BusinessException.class, () -> incomplete.service().declare(incomplete.reference()));
        verifyNoInteractions(dispositions);
    }

    @Test
    void rejectsUnknownFieldsAndUncertainCannotMasqueradeAsUnchanged() throws Exception {
        var extra = snapshot("{\"disposition\":\"unchanged\",\"reason\":\"x\",\"verified\":true}");
        assertThrows(BusinessException.class, () -> extra.service().declare(extra.reference()));
        var unknown = snapshot("{\"disposition\":\"uncertain\",\"reason\":\"Needs owner\"}");
        unknown.service().declare(unknown.reference());
        verify(dispositions).record(unknown.reference(), "uncertain", null, null, "Needs owner");
    }

    private Fixture snapshot(String declaration) throws Exception {
        Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(root.toString(), true);
        Path stage = git.stage();
        if (declaration != null) {
            Files.createDirectories(stage.resolve(".platform"));
            Files.writeString(stage.resolve(".platform/profile-disposition.json"), declaration);
        } else {
            Files.writeString(stage.resolve("source.txt"), "synthetic");
        }
        String runId = "run-" + java.util.UUID.randomUUID();
        var identity = git.commit(1, runId, "baseline", stage);
        var ref = new SnapshotReference(1, 2, runId, "baseline", null,
            identity.commitHash(), identity.treeHash());
        var row = new CandidateSourceSnapshot();
        row.setApplicationId(1L);
        row.setTaskId(2L);
        row.setRunId(runId);
        row.setBaselineHash("baseline");
        row.setCommitHash(identity.commitHash());
        row.setTreeHash(identity.treeHash());
        when(snapshots.requireReady(1, runId)).thenReturn(row);
        return new Fixture(ref, new SnapshotProfileDeclarationService(snapshots, git, dispositions,
            new ObjectMapper()));
    }

    private record Fixture(SnapshotReference reference, SnapshotProfileDeclarationService service) { }
}
