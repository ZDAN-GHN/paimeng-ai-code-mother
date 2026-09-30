package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;

import com.github.dockerjava.api.DockerClient;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
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

class CandidateFourGateExecutorTest {
    @TempDir Path root;

    @Test
    void missingDispositionBlocksEvenRejectedSource() throws Exception {
        var fixture = fixture("{\"scripts\":{\"test\":\"true\"}");
        when(fixture.dispositions().selectOneById(fixture.reference().runId())).thenReturn(null);
        var report = fixture.executor().validate(fixture.reference(), "{}");
        assertTrue(report.gates().stream().allMatch(g -> g.status() == CandidateFourGateExecutor.Status.INCONCLUSIVE
            && g.reasonCode().equals("PROFILE_DISPOSITION_MISSING")));
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void rejectsUntrustedDependencyManifestBeforeDocker() throws Exception {
        var fixture = fixture("{\"scripts\":{\"test\":\"true\"}");
        var report = fixture.executor().validate(fixture.reference(), "{}");
        assertEquals(CandidateFourGateExecutor.Status.FAIL, report.engineering().status());
        assertEquals("CANDIDATE_CONFIG_REJECTED", report.engineering().reasonCode());
        assertEquals(CandidateFourGateExecutor.Status.INCONCLUSIVE, report.database().status());
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void unavailableDockerCannotProduceAnyPass() throws Exception {
        var fixture = fullFixture(false, false);
        when(fixture.dispositions().selectOneById(fixture.reference().runId()))
            .thenReturn(disposition(fixture.reference(), "unchanged"));
        var report = fixture.executor().validate(fixture.reference(), "{}");
        assertTrue(report.gates().stream().noneMatch(CandidateFourGateExecutor.Gate::passed));
        assertEquals("ISOLATION_UNAVAILABLE", report.engineering().reasonCode());
    }

    @Test
    void refusesUnsafeMigrationAndSymlinkFromVerifiedGit() throws Exception {
        var unsafe = fullFixture(true, false);
        assertEquals("MIGRATION_REJECTED", unsafe.executor().validate(unsafe.reference(), "{}").database().reasonCode());
        verifyNoInteractions(unsafe.docker());
    }

    @Test
    void refusesSymlinkBeforeDocker() throws Exception {
        var linked = fullFixture(false, true);
        assertEquals("SNAPSHOT_REJECTED", linked.executor().validate(linked.reference(), "{}").engineering().reasonCode());
        verifyNoInteractions(linked.docker());
    }

    @Test
    void rejectsMalformedEscapingDuplicateAndSymlinkArchives() throws Exception {
        for (String[] paths : new String[][]{{"../escape"}, {"source.txt", "source.txt"}, {"linked"}}) {
            byte[] archive = tar(paths, paths[0].equals("linked"));
            var git = mock(CandidateGitStore.class);
            Process process = mock(Process.class);
            when(process.getInputStream()).thenReturn(new ByteArrayInputStream(archive));
            when(process.waitFor(30, java.util.concurrent.TimeUnit.SECONDS)).thenReturn(true);
            when(process.exitValue()).thenReturn(0);
            var ref = new SnapshotReference(1, 2, "run-tar", "baseline", null,
                "0".repeat(40), "1".repeat(40));
            when(git.archive(org.mockito.ArgumentMatchers.eq(1L), org.mockito.ArgumentMatchers.any()))
                .thenReturn(process);
            DockerClient docker = mock(DockerClient.class);
            var result = executor(git, ref, docker, mock(ProfileDispositionMapper.class), false).validate(ref, "{}");
            assertEquals("SNAPSHOT_REJECTED", result.engineering().reasonCode());
            verifyNoInteractions(docker);
        }
        var ref = new SnapshotReference(1, 2, "run-tar", "baseline", null,
            "0".repeat(40), "1".repeat(40));
        var git = mock(CandidateGitStore.class);
        Process truncated = mock(Process.class);
        when(truncated.getInputStream()).thenReturn(new ByteArrayInputStream(new byte[]{1, 2, 3}));
        when(git.archive(org.mockito.ArgumentMatchers.eq(1L), org.mockito.ArgumentMatchers.any()))
            .thenReturn(truncated);
        DockerClient docker = mock(DockerClient.class);
        assertTrue(executor(git, ref, docker, mock(ProfileDispositionMapper.class), false)
            .validate(ref, "{}").gates().stream()
            .noneMatch(CandidateFourGateExecutor.Gate::passed));
        verifyNoInteractions(docker);
    }

    @Test
    void rejectsSchemaGeneratorChangeBeforeDocker() throws Exception {
        var fixture = fullFixture(false, false, true);
        assertEquals("CANDIDATE_CONFIG_REJECTED",
            fixture.executor().validate(fixture.reference(), "{}").engineering().reasonCode());
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void missingOrMismatchedDispositionNeverRunsGates() throws Exception {
        var fixture = fullFixture(false, false);
        when(fixture.dispositions().selectOneById(fixture.reference().runId())).thenReturn(null);
        var missing = fixture.executor().validate(fixture.reference(), "{}");
        assertTrue(missing.gates().stream().allMatch(g -> g.status() == CandidateFourGateExecutor.Status.INCONCLUSIVE
            && g.reasonCode().equals("PROFILE_DISPOSITION_MISSING")));
        ProfileDisposition mismatch = disposition(fixture.reference(), "changed");
        mismatch.setTreeHash("0".repeat(40));
        when(fixture.dispositions().selectOneById(fixture.reference().runId())).thenReturn(mismatch);
        var rejected = fixture.executor().validate(fixture.reference(), "{}");
        assertTrue(rejected.gates().stream().allMatch(g -> g.status() == CandidateFourGateExecutor.Status.INCONCLUSIVE
            && g.reasonCode().equals("PROFILE_DISPOSITION_MISMATCH")));
        verifyNoInteractions(fixture.docker());
    }

    @Test
    void uncertainDispositionCannotPassAnyGate() throws Exception {
        var fixture = fullFixture(false, false);
        when(fixture.dispositions().selectOneById(fixture.reference().runId()))
            .thenReturn(disposition(fixture.reference(), "uncertain"));
        var report = fixture.executor().validate(fixture.reference(), "{}");
        assertTrue(report.gates().stream().allMatch(g -> g.status() == CandidateFourGateExecutor.Status.INCONCLUSIVE
            && g.reasonCode().equals("PROFILE_DISPOSITION_UNCERTAIN")));
        verifyNoInteractions(fixture.docker());
    }

    private static ProfileDisposition disposition(SnapshotReference ref, String value) {
        ProfileDisposition row = new ProfileDisposition();
        row.setApplicationId(ref.applicationId());
        row.setTaskId(ref.taskId());
        row.setRunId(ref.runId());
        row.setBaselineHash(ref.baselineHash());
        row.setBaseSourceRevision(ref.baseSourceRevision());
        row.setCommitHash(ref.commitHash());
        row.setTreeHash(ref.treeHash());
        row.setDisposition(value);
        return row;
    }

    private static byte[] tar(String[] paths, boolean symlink) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (TarArchiveOutputStream archive = new TarArchiveOutputStream(output)) {
            for (String path : paths) {
                TarArchiveEntry entry = symlink ? new TarArchiveEntry(path, TarArchiveEntry.LF_SYMLINK)
                    : new TarArchiveEntry(path);
                entry.setSize(0);
                archive.putArchiveEntry(entry);
                archive.closeArchiveEntry();
            }
            archive.finish();
        }
        return output.toByteArray();
    }

    private Fixture fullFixture(boolean unsafeMigration, boolean linked) throws Exception {
        return fullFixture(unsafeMigration, linked, false);
    }

    private Fixture fullFixture(boolean unsafeMigration, boolean linked, boolean schemaChanged) throws Exception {
        Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(root.toString(), true);
        Path stage = git.stage();
        Path template = Path.of("../assets/application-template");
        try (var files = Files.walk(template)) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                Path relative = template.relativize(file);
                if (relative.toString().startsWith("scripts/") || relative.toString().equals(".env")
                    || relative.toString().startsWith(".git") || relative.toString().equals("README.md")
                    || relative.toString().equals(".dockerignore") || relative.toString().startsWith("node_modules/")
                    || relative.toString().startsWith("dist/")) continue;
                Path target = stage.resolve(relative);
                Files.createDirectories(target.getParent());
                Files.copy(file, target);
            }
        }
        if (unsafeMigration) Files.writeString(stage.resolve("prisma/migrations/20260928000000_create_item/migration.sql"),
            "DROP TABLE `Item`;");
        if (schemaChanged) Files.writeString(stage.resolve("prisma/schema.prisma"),
            Files.readString(stage.resolve("prisma/schema.prisma")).replace("prisma-client-js", "custom"));
        if (linked) Files.createSymbolicLink(stage.resolve("linked.ts"), Path.of("package.json"));
        var identity = git.commit(1, "run-full", "baseline", stage);
        var reference = new SnapshotReference(1, 2, "run-full", "baseline", null,
            identity.commitHash(), identity.treeHash());
        DockerClient docker = mock(DockerClient.class);
        ProfileDispositionMapper dispositions = mock(ProfileDispositionMapper.class);
        return new Fixture(executor(git, reference, docker, dispositions, !unsafeMigration && !linked),
            reference, docker, dispositions);
    }

    private Fixture fixture(String manifest) throws Exception {
        Files.setPosixFilePermissions(root, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(root.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("package.json"), manifest);
        Files.writeString(stage.resolve("source.txt"), "fixture");
        var identity = git.commit(1, "run-1", "baseline", stage);
        var reference = new SnapshotReference(1, 2, "run-1", "baseline", null,
            identity.commitHash(), identity.treeHash());
        DockerClient docker = mock(DockerClient.class);
        ProfileDispositionMapper dispositions = mock(ProfileDispositionMapper.class);
        return new Fixture(executor(git, reference, docker, dispositions, false), reference, docker, dispositions);
    }

    private CandidateFourGateExecutor executor(CandidateGitStore git, SnapshotReference ref,
                                               DockerClient docker, ProfileDispositionMapper dispositions,
                                               boolean unavailable) {
        CandidateSnapshotService snapshots = mock(CandidateSnapshotService.class);
        CandidateSourceSnapshot row = new CandidateSourceSnapshot();
        row.setApplicationId(ref.applicationId());
        row.setTaskId(ref.taskId());
        row.setRunId(ref.runId());
        row.setBaselineHash(ref.baselineHash());
        row.setCommitHash(ref.commitHash());
        row.setTreeHash(ref.treeHash());
        when(snapshots.requireReady(ref.applicationId(), ref.runId())).thenReturn(row);
        when(dispositions.selectOneById(ref.runId())).thenReturn(disposition(ref, "unchanged"));
        return new CandidateFourGateExecutor(snapshots, git, dispositions,
            new StaticListableBeanFactory(unavailable ? Map.of() : Map.of("docker", docker))
                .getBeanProvider(DockerClient.class), new com.fasterxml.jackson.databind.ObjectMapper());
    }

    private record Fixture(CandidateFourGateExecutor executor, SnapshotReference reference, DockerClient docker,
                           ProfileDispositionMapper dispositions) { }
}
