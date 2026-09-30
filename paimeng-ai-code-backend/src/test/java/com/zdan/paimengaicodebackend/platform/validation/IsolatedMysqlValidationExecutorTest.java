package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.github.dockerjava.api.DockerClient;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

class IsolatedMysqlValidationExecutorTest {
    @TempDir Path root;

    @Test
    void readsOnlyVerifiedMigrationFromImmutableCommit() throws Exception {
        Fixture fixture = fixture("CREATE TABLE `Entry` (`id` INTEGER) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;");
        assertEquals(1, fixture.executor().loadMigrations(fixture.reference()).size());
        assertThrows(BusinessException.class, () -> fixture.executor().loadMigrations(
            new SnapshotReference(1, 2, "run-1", "baseline", null, "0".repeat(40), fixture.reference().treeHash())));
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void rejectsUnsafeSqlBeforeStartingContainer() throws Exception {
        Fixture fixture = fixture("DROP TABLE `Entry`;");
        var result = fixture.executor().validate(fixture.reference());
        assertFalse(result.passed());
        assertEquals("DESTRUCTIVE_SQL", result.reasonCode());
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void refusesSymlink() throws Exception {
        Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(root.toString(), true);
        Path stage = git.stage();
        Files.createDirectories(stage.resolve("prisma/migrations/20260928_add"));
        Files.writeString(stage.resolve("prisma/migrations/20260928_add/migration.sql"), "SELECT 1;");
        Files.createSymbolicLink(stage.resolve("prisma/migrations/20260928_add/linked.sql"), Path.of("migration.sql"));
        var identity = git.commit(1, "run-1", "baseline", stage);
        var reference = new SnapshotReference(1, 2, "run-1", "baseline", null,
            identity.commitHash(), identity.treeHash());
        assertThrows(BusinessException.class, () -> executor(git, reference, mock(DockerClient.class)).loadMigrations(reference));
    }

    @Test
    void refusesMissingMigration() throws Exception {
        Fixture fixture = fixture(null);
        var result = fixture.executor().validate(fixture.reference());
        assertFalse(result.passed());
        assertEquals("NO_MIGRATION", result.reasonCode());
        verifyNoInteractions(fixture.docker());
    }

    private Fixture fixture(String sql) throws Exception {
        Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(root.toString(), true);
        Path stage = git.stage();
        if (sql != null) {
            Path migration = stage.resolve("prisma/migrations/20260928_add/migration.sql");
            Files.createDirectories(migration.getParent());
            Files.writeString(migration, sql);
        } else Files.writeString(stage.resolve("source.txt"), "synthetic");
        var identity = git.commit(1, "run-1", "baseline", stage);
        var reference = new SnapshotReference(1, 2, "run-1", "baseline", null,
            identity.commitHash(), identity.treeHash());
        DockerClient docker = mock(DockerClient.class);
        return new Fixture(executor(git, reference, docker), reference, docker);
    }

    private IsolatedMysqlValidationExecutor executor(CandidateGitStore git, SnapshotReference ref, DockerClient docker) {
        CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
        CandidateSourceSnapshot row = new CandidateSourceSnapshot();
        row.setApplicationId(ref.applicationId());
        row.setTaskId(ref.taskId());
        row.setRunId(ref.runId());
        row.setBaselineHash(ref.baselineHash());
        row.setBaseSourceRevision(ref.baseSourceRevision());
        row.setCommitHash(ref.commitHash());
        row.setTreeHash(ref.treeHash());
        when(snapshots.requireReady(ref.applicationId(), ref.runId())).thenReturn(row);
        return new IsolatedMysqlValidationExecutor(snapshots, git,
            new StaticListableBeanFactory(Map.of("docker", docker)).getBeanProvider(DockerClient.class));
    }

    private record Fixture(IsolatedMysqlValidationExecutor executor, SnapshotReference reference, DockerClient docker) { }
}
