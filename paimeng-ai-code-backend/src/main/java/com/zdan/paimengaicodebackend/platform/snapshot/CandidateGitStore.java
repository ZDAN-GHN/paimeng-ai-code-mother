package com.zdan.paimengaicodebackend.platform.snapshot;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** A private bare repository per Application; snapshot refs are never moved or garbage-collected. */
@Component
public class CandidateGitStore {
    private static final String ZERO = "0000000000000000000000000000000000000000";
    private static final int MAX_COMMAND_OUTPUT = 8192;
    private static final int MAX_EVIDENCE_BYTES = 65536;
    private final Path root;
    private final boolean executionEnabled;

    public CandidateGitStore(@Value("${platform.snapshot.repo-root:}") String root,
                             @Value("${platform.execution.enabled:false}") boolean executionEnabled) {
        this.root = root.isBlank() ? null : Path.of(root).toAbsolutePath().normalize();
        this.executionEnabled = executionEnabled;
        if (executionEnabled) {
            requireRoot();
            try {
                command(Map.of(), "--version");
            } catch (IOException e) {
                throw new BusinessException(ErrorCode.OPERATION_ERROR, "Snapshot Git 可执行文件不可用");
            }
        }
    }

    public Path stage() throws IOException {
        requireRoot();
        return Files.createTempDirectory(root, ".snapshot-stage-");
    }

    public GitIdentity commit(long appId, String runId, String baselineHash, Path stage) throws IOException {
        Path repo = repository(appId);
        String ref = "refs/candidates/" + sha256(runId);
        Path index = null;
        Throwable primaryFailure = null;
        try {
            index = Files.createTempFile(root, ".snapshot-index-", "");
            // GIT_INDEX_FILE must point to a missing path; an existing zero-byte file is corrupt.
            Files.delete(index);
            Map<String, String> env = Map.of("GIT_DIR", repo.toString(), "GIT_WORK_TREE", stage.toString(),
                "GIT_INDEX_FILE", index.toString(), "GIT_AUTHOR_NAME", "Platform",
                "GIT_AUTHOR_EMAIL", "platform@localhost", "GIT_COMMITTER_NAME", "Platform",
                "GIT_COMMITTER_EMAIL", "platform@localhost", "GIT_AUTHOR_DATE", "@0 +0000",
                "GIT_COMMITTER_DATE", "@0 +0000");
            command(env, "-c", "core.filemode=false", "add", "-A", "--", ".");
            String tree = command(env, "write-tree").trim();
            String message = "Candidate " + sha256(runId + "\n" + baselineHash);
            String commit = command(env, "commit-tree", tree, "-m", message).trim();
            String existing = command(env, "rev-parse", "--verify", "--quiet", ref).trim();
            if (existing.isEmpty()) {
                try {
                    command(env, "update-ref", ref, commit, ZERO);
                } catch (IOException concurrent) {
                    existing = command(env, "rev-parse", "--verify", "--quiet", ref).trim();
                    if (!commit.equals(existing)) throw concurrent;
                }
            } else if (!commit.equals(existing)) {
                throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 的候选文件树已变化");
            }
            GitIdentity identity = new GitIdentity(commit, tree);
            verify(appId, runId, identity);
            return identity;
        } catch (IOException | RuntimeException e) {
            primaryFailure = e;
            throw e;
        } finally {
            if (index != null) {
                try {
                    Files.deleteIfExists(index);
                } catch (IOException e) {
                    if (primaryFailure == null) throw e;
                    primaryFailure.addSuppressed(e);
                }
            }
        }
    }

    public void verify(long appId, String runId, GitIdentity identity) throws IOException {
        if (!identity.commitHash().matches("[0-9a-f]{40}") || !identity.treeHash().matches("[0-9a-f]{40}")) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot Git 标识无效");
        }
        Path repo = repository(appId);
        Map<String, String> env = Map.of("GIT_DIR", repo.toString());
        if (!identity.commitHash().equals(command(env, "rev-parse", "--verify",
            "refs/candidates/" + sha256(runId)).trim())
            || !identity.treeHash().equals(command(env, "rev-parse", identity.commitHash() + "^{tree}").trim())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot Git 引用或文件树不一致");
        }
        command(env, "fsck", "--no-reflogs", "--full", identity.commitHash());
    }

    /** A stable artifactId supports retry after a Git write succeeds but the database insert fails. */
    public ArtifactReference persistEvidence(SnapshotReference snapshot, String artifactId, byte[] bytes)
        throws IOException {
        if (snapshot == null || snapshot.runId() == null || snapshot.applicationId() <= 0
            || artifactId == null || !artifactId.matches("[A-Za-z0-9_-]{1,64}")
            || bytes == null || bytes.length == 0 || bytes.length > MAX_EVIDENCE_BYTES) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "证据对象参数无效");
        }
        verify(snapshot.applicationId(), snapshot.runId(),
            new GitIdentity(snapshot.commitHash(), snapshot.treeHash()));
        String ref = "refs/evidence/" + sha256(snapshot.runId() + "\n" + artifactId);
        byte[] binding = evidenceBinding(snapshot);
        Path repo = repository(snapshot.applicationId());
        Path stage = stage();
        Path index = null;
        try {
            index = Files.createTempFile(root, ".evidence-index-", "");
            Files.delete(index);
            Files.write(stage.resolve("artifact.bin"), bytes);
            Files.write(stage.resolve("binding.bin"), binding);
            Map<String, String> env = Map.of("GIT_DIR", repo.toString(), "GIT_WORK_TREE", stage.toString(),
                "GIT_INDEX_FILE", index.toString(), "GIT_AUTHOR_NAME", "Platform",
                "GIT_AUTHOR_EMAIL", "platform@localhost", "GIT_COMMITTER_NAME", "Platform",
                "GIT_COMMITTER_EMAIL", "platform@localhost", "GIT_AUTHOR_DATE", "@0 +0000",
                "GIT_COMMITTER_DATE", "@0 +0000");
            command(env, "-c", "core.filemode=false", "add", "-A", "--", ".");
            String tree = command(env, "write-tree").trim();
            String commit = command(env, "commit-tree", tree, "-m", "Evidence " + sha256(binding)).trim();
            String existing = command(env, "rev-parse", "--verify", "--quiet", ref).trim();
            if (existing.isEmpty()) {
                try {
                    command(env, "update-ref", ref, commit, ZERO);
                } catch (IOException concurrent) {
                    existing = command(env, "rev-parse", "--verify", "--quiet", ref).trim();
                    if (!commit.equals(existing)) throw concurrent;
                }
            } else if (!commit.equals(existing)) {
                throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "证据引用已绑定其他内容");
            }
            ArtifactReference identity = new ArtifactReference(ref, commit, sha256(bytes));
            verifyEvidence(snapshot, identity);
            return identity;
        } finally {
            try {
                if (index != null) Files.deleteIfExists(index);
            } finally {
                Files.deleteIfExists(stage.resolve("artifact.bin"));
                Files.deleteIfExists(stage.resolve("binding.bin"));
                Files.deleteIfExists(stage);
            }
        }
    }

    public void verifyEvidence(SnapshotReference snapshot, ArtifactReference artifact) throws IOException {
        if (snapshot == null || snapshot.runId() == null || artifact == null
            || artifact.ref() == null || artifact.commitHash() == null || artifact.sha256() == null
            || !artifact.ref().matches("refs/evidence/[0-9a-f]{64}")
            || !artifact.commitHash().matches("[0-9a-f]{40}")
            || !artifact.sha256().matches("[0-9a-f]{64}")) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "证据引用无效");
        }
        Path repo = repository(snapshot.applicationId());
        Map<String, String> env = Map.of("GIT_DIR", repo.toString());
        if (!artifact.commitHash().equals(command(env, "rev-parse", "--verify", artifact.ref()).trim())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "证据引用已移动");
        }
        byte[] binding = readEvidenceBlob(env, artifact.commitHash() + ":binding.bin");
        byte[] bytes = readEvidenceBlob(env, artifact.commitHash() + ":artifact.bin");
        if (!Arrays.equals(binding, evidenceBinding(snapshot)) || bytes.length == 0
            || !artifact.sha256().equals(sha256(bytes))) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "证据对象或归属不一致");
        }
        command(env, "fsck", "--no-reflogs", "--full", artifact.commitHash());
    }

    private byte[] evidenceBinding(SnapshotReference snapshot) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (DataOutputStream data = new DataOutputStream(output)) {
            data.writeLong(snapshot.applicationId());
            data.writeLong(snapshot.taskId());
            for (String value : new String[]{snapshot.runId(), snapshot.baselineHash(),
                snapshot.baseSourceRevision(), snapshot.commitHash(), snapshot.treeHash()}) {
                data.writeBoolean(value != null);
                if (value != null) data.writeUTF(value);
            }
        }
        return output.toByteArray();
    }

    private byte[] readEvidenceBlob(Map<String, String> env, String spec) throws IOException {
        Process process = process(env, "cat-file", "blob", spec);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        AtomicReference<IOException> failure = new AtomicReference<>();
        Thread reader = Thread.ofVirtual().start(() -> {
            try (InputStream input = process.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) >= 0) {
                    if (output.size() + count > MAX_EVIDENCE_BYTES) {
                        throw new IOException("证据对象超过上限");
                    }
                    output.write(buffer, 0, count);
                }
            } catch (IOException e) {
                failure.set(e);
                process.destroyForcibly();
            }
        });
        try {
            if (!process.waitFor(30, TimeUnit.SECONDS)) throw new IOException("证据读取超时");
            reader.join(5_000);
            if (reader.isAlive()) throw new IOException("证据输出读取超时");
            if (failure.get() != null) throw failure.get();
            if (process.exitValue() != 0) throw new IOException("证据对象不可读取");
            return output.toByteArray();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("证据读取被中断", e);
        } finally {
            process.destroyForcibly();
            reader.interrupt();
        }
    }

    public record ArtifactReference(String ref, String commitHash, String sha256) { }

    public Process archive(long appId, GitIdentity identity) throws IOException {
        Path repo = repository(appId);
        Process process = process(Map.of("GIT_DIR", repo.toString()),
            "archive", "--format=tar", identity.commitHash());
        return process;
    }

    private Path repository(long appId) throws IOException {
        requireRoot();
        if (appId <= 0) throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application 标识无效");
        Path repo = root.resolve("app-" + appId + ".git");
        if (Files.isSymbolicLink(repo)) throw new IOException("Snapshot 仓库不得是符号链接");
        if (!Files.exists(repo, LinkOption.NOFOLLOW_LINKS)) {
            try {
                Files.createDirectory(repo);
                Files.setPosixFilePermissions(repo, Set.of(PosixFilePermission.OWNER_READ,
                    PosixFilePermission.OWNER_WRITE, PosixFilePermission.OWNER_EXECUTE));
                command(Map.of(), "init", "--bare", "--template=/dev/null", repo.toString());
            } catch (java.nio.file.FileAlreadyExistsException concurrent) {
                // Another writer created the same Application repository.
            }
        }
        if (!Files.isDirectory(repo, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(repo)) throw new IOException("Snapshot 仓库不可读");
        requirePrivateDirectory(repo);
        if (!"true".equals(command(Map.of("GIT_DIR", repo.toString()), "rev-parse",
                "--is-bare-repository").trim())) throw new IOException("Snapshot 仓库不可读");
        return repo;
    }

    private void requireRoot() {
        if (root == null || !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)
            || Files.isSymbolicLink(root) || !Files.isWritable(root)) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Platform 私有 Git 持久卷不可用");
        }
        try {
            requirePrivateDirectory(root);
        } catch (IOException e) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "Platform 私有 Git 持久卷权限不可确认");
        }
    }

    private void requirePrivateDirectory(Path path) throws IOException {
        Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path);
        if (permissions.contains(PosixFilePermission.GROUP_READ)
            || permissions.contains(PosixFilePermission.GROUP_WRITE)
            || permissions.contains(PosixFilePermission.GROUP_EXECUTE)
            || permissions.contains(PosixFilePermission.OTHERS_READ)
            || permissions.contains(PosixFilePermission.OTHERS_WRITE)
            || permissions.contains(PosixFilePermission.OTHERS_EXECUTE)) {
            throw new IOException("Snapshot 存储目录不是私有目录");
        }
    }

    private String command(Map<String, String> extra, String... args) throws IOException {
        Process process = process(extra, args);
        ByteArrayOutputStream captured = new ByteArrayOutputStream(MAX_COMMAND_OUTPUT);
        AtomicReference<IOException> readFailure = new AtomicReference<>();
        Thread reader = Thread.ofVirtual().start(() -> drain(process.getInputStream(), captured, readFailure));
        try {
            if (!process.waitFor(30, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IOException("Git 命令超时");
            }
            reader.join(5_000);
            if (reader.isAlive()) throw new IOException("Git 命令输出读取超时");
            IOException failure = readFailure.get();
            if (failure != null) throw failure;
            String output = captured.toString(StandardCharsets.UTF_8);
            if (process.exitValue() != 0 && !(args.length >= 3 && "--quiet".equals(args[2]))) {
                throw new IOException("Git 命令失败 (exit=" + process.exitValue() + "): " + output);
            }
            return output;
        } catch (InterruptedException e) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IOException("Git 命令被中断", e);
        } finally {
            process.destroyForcibly();
            reader.interrupt();
            try {
                process.getInputStream().close();
            } catch (IOException ignored) {
                // The process is already being terminated; preserve the command failure.
            }
        }
    }

    private void drain(InputStream input, ByteArrayOutputStream captured,
                       AtomicReference<IOException> readFailure) {
        try (input) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                int remaining = MAX_COMMAND_OUTPUT - captured.size();
                if (remaining > 0) captured.write(buffer, 0, Math.min(read, remaining));
            }
        } catch (IOException e) {
            readFailure.set(e);
        }
    }

    private Process process(Map<String, String> extra, String... args) throws IOException {
        List<String> command = new ArrayList<>(List.of("git", "-c", "core.hooksPath=/dev/null",
            "-c", "core.autocrlf=false"));
        command.addAll(List.of(args));
        ProcessBuilder builder = new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true);
        Map<String, String> environment = builder.environment();
        environment.clear();
        environment.put("PATH", "/usr/bin:/bin");
        environment.put("HOME", root.toString());
        environment.put("GIT_CONFIG_NOSYSTEM", "1");
        environment.put("GIT_CONFIG_GLOBAL", "/dev/null");
        environment.put("GIT_NO_REPLACE_OBJECTS", "1");
        environment.putAll(extra);
        return builder.start();
    }

    public static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public record GitIdentity(String commitHash, String treeHash) { }
}
