package com.zdan.paimengaicodebackend.platform.validation;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/** Platform-only migration probe. No caller SQL, path, database address or image is accepted. */
@Slf4j
@Service
public class IsolatedMysqlValidationExecutor {
    private static final String IMAGE = "mysql:8.0.46";
    private static final String LABEL = "com.zdan.paimeng.platform.validation";
    private static final int MAX_MIGRATIONS = 64;
    private static final int MAX_SQL_BYTES = 65536;
    private static final int MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
    private static final int MAX_ENTRIES = 4096;
    private static final int STARTUP_SECONDS = 30;
    private static final int COMMAND_SECONDS = 30;
    private static final String SQL_PATH = "/tmp/validation-migration.sql";
    private static final String SOCKET = "/var/run/mysqld/mysqld.sock";
    private final CandidateSnapshotService snapshots;
    private final CandidateGitStore git;
    private final MigrationSafetyGate gate = new MigrationSafetyGate();
    private final ObjectProvider<DockerClient> dockerProvider;

    public IsolatedMysqlValidationExecutor(CandidateSnapshotService snapshots, CandidateGitStore git,
                                           ObjectProvider<DockerClient> dockerProvider) {
        this.snapshots = snapshots;
        this.git = git;
        this.dockerProvider = dockerProvider;
    }

    /** A denial is returned as a reason code. Failed cleanup is never reported as PASS. */
    public Result validate(SnapshotReference reference) {
        List<Migration> migrations;
        try {
            migrations = loadMigrations(reference);
        } catch (BusinessException e) {
            return new Result(false, "SNAPSHOT_REJECTED");
        } catch (IOException e) {
            log.warn("Validation snapshot read failed, runId={}, category=io", safeRunId(reference), e);
            return new Result(false, "SNAPSHOT_UNAVAILABLE");
        }
        if (migrations.isEmpty()) return new Result(false, "NO_MIGRATION");
        for (Migration migration : migrations) {
            MigrationSafetyGate.Decision decision = gate.evaluate(migration.sql());
            if (!decision.allowed()) return new Result(false, decision.reasonCode());
        }
        DockerClient docker = dockerProvider.getIfAvailable();
        if (docker == null) return new Result(false, "ISOLATION_UNAVAILABLE");
        String containerId = null;
        Result result;
        try {
            // network=none supplies only loopback. MySQL itself is also started with --skip-networking.
            // All writable locations, including the image's declared volume, are in memory.
            HostConfig host = HostConfig.newHostConfig().withNetworkMode("none")
                .withReadonlyRootfs(true).withPrivileged(false).withCapDrop(Capability.ALL)
                .withSecurityOpts(List.of("no-new-privileges:true"))
                .withMemory(1024L * 1024 * 1024).withMemorySwap(1024L * 1024 * 1024)
                .withNanoCPUs(1_000_000_000L).withPidsLimit(128L)
                .withTmpFs(Map.of("/var/lib/mysql", "rw,noexec,nosuid,size=512m,uid=999,gid=999",
                    "/var/run/mysqld", "rw,noexec,nosuid,size=8m,uid=999,gid=999",
                    "/tmp", "rw,noexec,nosuid,size=64m,uid=999,gid=999"));
            CreateContainerResponse created = docker.createContainerCmd(IMAGE)
                .withUser("999:999").withHostConfig(host)
                .withEnv("MYSQL_ALLOW_EMPTY_PASSWORD=yes", "MYSQL_DATABASE=validation")
                .withCmd("mysqld", "--skip-networking", "--socket=" + SOCKET)
                .withLabels(Map.of(LABEL, "mysql-migration-probe"))
                .exec();
            containerId = created.getId();
            docker.startContainerCmd(containerId).exec();
            String id = containerId;
            long deadline = System.nanoTime() + Duration.ofSeconds(STARTUP_SECONDS).toNanos();
            boolean ready = false;
            while (System.nanoTime() < deadline) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
                try {
                    if (exec(docker, id, "SELECT 1;", COMMAND_SECONDS) == 0) {
                        ready = true;
                        break;
                    }
                } catch (RuntimeException e) {
                    // Startup may not have created the local socket yet.
                }
                TimeUnit.MILLISECONDS.sleep(500);
            }
            if (!ready) {
                var state = docker.inspectContainerCmd(id).exec().getState();
                log.warn("Isolated MySQL startup unavailable, runId={}, status={}, exitCode={}",
                    safeRunId(reference), state.getStatus(), state.getExitCodeLong());
                result = new Result(false, "DATABASE_UNAVAILABLE");
            } else {
                result = new Result(true, "PASS");
                long migrationDeadline = System.nanoTime() + Duration.ofSeconds(180).toNanos();
                for (Migration migration : migrations) {
                    if (exec(docker, id, migration.sql(), remainingSeconds(migrationDeadline)) != 0) {
                        result = new Result(false, "MIGRATION_FAILED");
                        break;
                    }
                }
                // A fixed synthetic operation checks the migrated database without accepting Task SQL.
                if (result.passed() && exec(docker, id,
                    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'validation';",
                    remainingSeconds(migrationDeadline)) != 0) result = new Result(false, "OPERATION_FAILED");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            result = new Result(false, "CANCELLED");
        } catch (CommandTimeoutException e) {
            result = new Result(false, "DATABASE_TIMEOUT");
        } catch (RuntimeException e) {
            log.warn("Isolated migration probe failed, runId={}, category=runtime", safeRunId(reference), e);
            result = new Result(false, "ISOLATION_FAILED");
        }
        if (containerId != null) {
            try {
                docker.removeContainerCmd(containerId).withForce(true).withRemoveVolumes(true).exec();
            } catch (RuntimeException e) {
                log.error("Isolated migration container cleanup failed, runId={}, containerId={}",
                    safeRunId(reference), containerId, e);
                return new Result(false, "CLEANUP_FAILED");
            }
        }
        return result;
    }

    /** Verified identity plus bounded Git archive; no archive entry is materialized on the host. */
    List<Migration> loadMigrations(SnapshotReference reference) throws IOException {
        if (reference == null) throw denied();
        reference.require(snapshots);
        var identity = new CandidateGitStore.GitIdentity(reference.commitHash(), reference.treeHash());
        git.verify(reference.applicationId(), reference.runId(), identity);
        Process process = git.archive(reference.applicationId(), identity);
        try {
            List<Migration> migrations = new ArrayList<>();
            Set<String> names = new HashSet<>();
            int entries = 0;
            long bytes = 0;
            try (InputStream input = process.getInputStream(); TarArchiveInputStream tar = new TarArchiveInputStream(input)) {
                TarArchiveEntry entry;
                while ((entry = tar.getNextEntry()) != null) {
                    String name = entry.getName();
                    if (++entries > MAX_ENTRIES || name == null || name.length() > 1024
                        || name.startsWith("/") || name.indexOf('\\') >= 0
                        || name.chars().anyMatch(ch -> ch < 32 || ch == 127)
                        || !names.add(name) || !safeName(name)
                        || !(entry.isDirectory() || (entry.isFile() && !entry.isSymbolicLink() && !entry.isLink()))
                        || entry.isSparse() || entry.isGNUSparse() || (entry.getMode() & 07000) != 0
                        || entry.getSize() < 0 || (bytes += entry.getSize()) > MAX_ARCHIVE_BYTES) throw denied();
                    if (!entry.isFile()) continue;
                    if (name.startsWith("prisma/migrations/") && name.endsWith("/migration.sql")) {
                        if (!name.matches("prisma/migrations/[A-Za-z0-9_-]{1,128}/migration\\.sql")
                            || migrations.size() >= MAX_MIGRATIONS || entry.getSize() > MAX_SQL_BYTES) throw denied();
                        byte[] sql = tar.readNBytes((int) entry.getSize());
                        if (sql.length != entry.getSize()) throw denied();
                        try {
                            String text = StandardCharsets.UTF_8.newDecoder()
                                .onMalformedInput(CodingErrorAction.REPORT)
                                .onUnmappableCharacter(CodingErrorAction.REPORT)
                                .decode(ByteBuffer.wrap(sql)).toString();
                            migrations.add(new Migration(name, text));
                        } catch (CharacterCodingException e) {
                            throw denied();
                        }
                    }
                }
            }
            if (!process.waitFor(30, TimeUnit.SECONDS) || process.exitValue() != 0) throw denied();
            return migrations;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Git archive interrupted", e);
        } finally {
            process.destroyForcibly();
        }
    }

    private static boolean safeName(String name) {
        String[] parts = name.split("/", -1);
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (part.isEmpty() && i == parts.length - 1) continue;
            if (part.isEmpty() || part.equals(".") || part.equals("..")) return false;
        }
        return true;
    }

    private static int exec(DockerClient docker, String containerId, String sql, int timeoutSeconds)
        throws InterruptedException {
        boolean health = sql.equals("SELECT 1;");
        byte[] content = health ? null : sql.getBytes(StandardCharsets.UTF_8);
        String[] command = health ? new String[]{"mysql", "--protocol=socket", "--socket=" + SOCKET,
            "--user=root", "--batch", "--skip-column-names", "validation", "--execute=SELECT 1;"}
            : new String[]{"sh", "-c", "dd bs=1 count=" + content.length + " of=" + SQL_PATH
                + " status=none && exec mysql --protocol=socket --socket=" + SOCKET
                + " --user=root --batch --skip-column-names validation --execute='source " + SQL_PATH + "'"};
        String execId = docker.execCreateCmd(containerId).withAttachStdin(!health)
            .withAttachStdout(true).withAttachStderr(true).withCmd(command).exec().getId();
        try (ResultCallback.Adapter<Frame> callback = new ResultCallback.Adapter<>()) {
            var start = docker.execStartCmd(execId);
            if (!health) start.withStdIn(new ByteArrayInputStream(content));
            start.exec(callback);
            if (!callback.awaitCompletion(timeoutSeconds, TimeUnit.SECONDS)) {
                throw new CommandTimeoutException();
            }
        } catch (IOException e) {
            throw new IllegalStateException("MySQL command stream failed", e);
        }
        Long exit = docker.inspectExecCmd(execId).exec().getExitCodeLong();
        return exit == null ? -1 : exit.intValue();
    }

    private static int remainingSeconds(long deadline) {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) throw new CommandTimeoutException();
        return (int) Math.min(COMMAND_SECONDS, Math.max(1, TimeUnit.NANOSECONDS.toSeconds(remaining)));
    }

    private static BusinessException denied() {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Snapshot Migration 条目不可信");
    }

    private static String safeRunId(SnapshotReference reference) {
        return reference == null ? "missing" : reference.runId();
    }

    private static final class CommandTimeoutException extends RuntimeException { }

    public record Result(boolean passed, String reasonCode) { }
    record Migration(String name, String sql) { }
}
