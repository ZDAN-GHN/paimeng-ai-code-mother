package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Duration;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class CandidateGitStoreTest {
    @TempDir Path privateRoot;

    @Test
    void stableRetryReturnsImmutableCommitAndChangedTreeIsRejected() throws IOException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path first = git.stage();
        Files.writeString(first.resolve("source.txt"), "v1");
        var identity = git.commit(101L, "run-1", "baseline", first);
        assertEquals(identity, git.commit(101L, "run-1", "baseline", first));
        git.verify(101L, "run-1", identity);
        Path second = git.stage();
        Files.writeString(second.resolve("source.txt"), "v2");
        assertThrows(BusinessException.class, () -> git.commit(101L, "run-1", "baseline", second));
    }

    @Test
    void rejectsRepositoryRootReadableByOtherUsers() throws IOException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE,
            PosixFilePermission.GROUP_READ, PosixFilePermission.GROUP_EXECUTE));
        assertThrows(BusinessException.class, () -> new CandidateGitStore(privateRoot.toString(), true));
    }

    @Test
    void verificationDrainsLargeFsckOutputWithoutBlockingGit() throws IOException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("source.txt"), "v1");
        var identity = git.commit(101L, "run-1", "baseline", stage);
        Path repo = privateRoot.resolve("app-101.git");
        for (int i = 0; i < 200; i++) {
            Process object = new ProcessBuilder("git", "--git-dir=" + repo,
                "hash-object", "-w", "--stdin").start();
            try (var input = object.getOutputStream()) {
                input.write(("unreachable-" + i).getBytes(StandardCharsets.UTF_8));
            }
            try {
                assertEquals(0, object.waitFor());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException(e);
            }
        }
        assertTimeoutPreemptively(Duration.ofSeconds(15), () -> git.verify(101L, "run-1", identity));
    }

    @Test
    void refusesUnregisteredObjectAndMissingRoot() throws IOException {
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), false);
        assertThrows(IOException.class, () -> git.verify(12L, "run-1",
            new CandidateGitStore.GitIdentity("a".repeat(40), "b".repeat(40))));
        assertThrows(BusinessException.class, () -> new CandidateGitStore(
            privateRoot.resolve("missing").toString(), true));
    }

    @Test
    void evidenceReferenceIsImmutableBoundedAndSnapshotBound() throws IOException, InterruptedException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("source.txt"), "v1");
        var source = git.commit(101L, "run-1", "baseline", stage);
        var snapshot = new SnapshotReference(101L, 2L, "run-1", "baseline", null,
            source.commitHash(), source.treeHash());
        byte[] bytes = new byte[]{0, (byte) 0xff, 10, 0};
        var artifact = git.persistEvidence(snapshot, "build-1", bytes);
        assertEquals(artifact, git.persistEvidence(snapshot, "build-1", bytes));
        git.verifyEvidence(snapshot, artifact);
        assertEquals(CandidateGitStore.sha256(bytes), artifact.sha256());
        assertThrows(BusinessException.class, () -> git.persistEvidence(snapshot, "build-1", new byte[]{1}));
        assertThrows(BusinessException.class, () -> git.persistEvidence(snapshot, "big", new byte[65537]));
        byte[] maximum = new byte[65536];
        var bounded = git.persistEvidence(snapshot, "maximum", maximum);
        git.verifyEvidence(snapshot, bounded);
        assertThrows(BusinessException.class, () -> git.verifyEvidence(snapshot,
            new CandidateGitStore.ArtifactReference(artifact.ref(), source.commitHash(), artifact.sha256())));
        assertThrows(BusinessException.class, () -> git.verifyEvidence(snapshot,
            new CandidateGitStore.ArtifactReference(artifact.ref(), artifact.commitHash(), "0".repeat(64))));
        assertThrows(BusinessException.class, () -> git.verifyEvidence(
            new SnapshotReference(101L, 2L, "run-2", "baseline", null,
                source.commitHash(), source.treeHash()), artifact));
        assertThrows(BusinessException.class, () -> git.verifyEvidence(
            new SnapshotReference(101L, 3L, "run-1", "baseline", null,
                source.commitHash(), source.treeHash()), artifact));
        assertThrows(BusinessException.class, () -> git.verifyEvidence(
            new SnapshotReference(101L, 2L, "run-1", "baseline", "different",
                source.commitHash(), source.treeHash()), artifact));
        assertThrows(IOException.class, () -> git.verifyEvidence(
            new SnapshotReference(102L, 2L, "run-1", "baseline", null,
                source.commitHash(), source.treeHash()), artifact));
        Path repo = privateRoot.resolve("app-101.git");
        Process moved = new ProcessBuilder("git", "--git-dir=" + repo, "update-ref", artifact.ref(),
            source.commitHash(), artifact.commitHash()).start();
        assertEquals(0, moved.waitFor());
        assertThrows(BusinessException.class, () -> git.verifyEvidence(snapshot, artifact));
    }

    @Test
    void evidenceMustReferToRegisteredSnapshotCommit() throws IOException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        assertThrows(IOException.class, () -> git.persistEvidence(
            new SnapshotReference(101L, 2L, "run-1", "baseline", null, "a".repeat(40), "b".repeat(40)),
            "build-1", new byte[]{1}));
    }

    @Test
    void missingEvidenceRefFailsVerification() throws IOException, InterruptedException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("source.txt"), "v1");
        var source = git.commit(101L, "run-1", "baseline", stage);
        var snapshot = new SnapshotReference(101L, 2L, "run-1", "baseline", null,
            source.commitHash(), source.treeHash());
        var artifact = git.persistEvidence(snapshot, "build-1", new byte[]{1});
        Path repo = privateRoot.resolve("app-101.git");
        Process deleted = new ProcessBuilder("git", "--git-dir=" + repo, "update-ref", "-d",
            artifact.ref()).start();
        assertEquals(0, deleted.waitFor());
        assertThrows(IOException.class, () -> git.verifyEvidence(snapshot, artifact));
    }

    @Test
    void missingEvidenceBlobFailsVerification() throws IOException, InterruptedException {
        Files.setPosixFilePermissions(privateRoot, Set.of(PosixFilePermission.OWNER_READ,
            PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
        CandidateGitStore git = new CandidateGitStore(privateRoot.toString(), true);
        Path stage = git.stage();
        Files.writeString(stage.resolve("source.txt"), "v1");
        var source = git.commit(101L, "run-1", "baseline", stage);
        var snapshot = new SnapshotReference(101L, 2L, "run-1", "baseline", null,
            source.commitHash(), source.treeHash());
        var artifact = git.persistEvidence(snapshot, "build-1", new byte[]{1});
        Path repo = privateRoot.resolve("app-101.git");
        Process lookup = new ProcessBuilder("git", "--git-dir=" + repo, "rev-parse",
            artifact.commitHash() + ":artifact.bin").start();
        String blob = new String(lookup.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assertEquals(0, lookup.waitFor());
        Files.delete(repo.resolve("objects").resolve(blob.substring(0, 2)).resolve(blob.substring(2)));
        assertThrows(IOException.class, () -> git.verifyEvidence(snapshot, artifact));
    }
}
