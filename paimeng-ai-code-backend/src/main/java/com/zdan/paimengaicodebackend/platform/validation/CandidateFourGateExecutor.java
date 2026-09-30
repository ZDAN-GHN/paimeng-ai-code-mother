package com.zdan.paimengaicodebackend.platform.validation;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.model.Capability;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;
import com.github.dockerjava.api.model.Mount;
import com.github.dockerjava.api.model.MountType;
import com.github.dockerjava.api.exception.NotFoundException;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.ProfileDispositionMapper;
import com.zdan.paimengaicodebackend.platform.entity.ProfileDisposition;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateGitStore;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.snapshot.SnapshotReference;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

/** Runs four Platform-owned gates against a verified READY Git snapshot; never persists evidence. */
@Slf4j
@Service
public class CandidateFourGateExecutor {
    private static final String IMAGE = "issue79-validation-runtime:local";
    private static final String MYSQL_IMAGE = "mysql:8.0.46";
    private static final String LOCK_SHA = "ab59c23c9f878615a88dcc1bc03c39159abb6c8f782b86deb82cc8c22573ac26";
    private static final String LABEL = "com.zdan.paimeng.platform.validation";
    private static final long MAX_BYTES = 64L * 1024 * 1024;
    private static final String SCHEMA_HEADER = """
        generator client {
          provider = "prisma-client-js"
        }

        datasource db {
          provider = "mysql"
        }

        """;
    private static final Map<String, String> PINNED = Map.of(
        "package.json", "c0e14ab2ed1013482b745fc18d057dbee26822b9d405882893a23094ced591f6",
        "package-lock.json", LOCK_SHA,
        "prisma.config.ts", "b723f52f5be83831d82a966be27d52296c789eadc5449e9550179bf17e469904",
        "tsconfig.server.json", "408604600745362ce74527d36ec3f5b7e8f44256235d85622dbfc504d5ff3900",
        "tsconfig.test.json", "fa416610f6507279fd9e00c65207efa979d4b8790392d6e35ffa0b9a342831cd",
        "tsconfig.web.json", "244e96e876d0932f70b09cdc10399d27cb33d4a980d0397aea52e70a088d27df",
        "vite.config.ts", "dde445de0a9bd3a014ff127d9b934774beb4979bf4001c76191652e673c2375b",
        "prisma/migrations/migration_lock.toml", "00969ee045a3c3f087a3460235a1a744c1e35bde4441e0c55e163225eb077608");
    private final CandidateSnapshotService snapshots;
    private final CandidateGitStore git;
    private final ProfileDispositionMapper dispositions;
    private final ObjectProvider<DockerClient> dockerProvider;
    private final ObjectMapper mapper;
    private final MigrationSafetyGate migrationGate = new MigrationSafetyGate();

    public CandidateFourGateExecutor(CandidateSnapshotService snapshots, CandidateGitStore git,
                                     ProfileDispositionMapper dispositions,
                                     ObjectProvider<DockerClient> dockerProvider, ObjectMapper mapper) {
        this.snapshots = snapshots;
        this.git = git;
        this.dispositions = dispositions;
        this.dockerProvider = dockerProvider;
        this.mapper = mapper;
    }

    public enum Status { PASS, FAIL, INCONCLUSIVE }
    public record Gate(Status status, String reasonCode) {
        public boolean passed() { return status == Status.PASS; }
    }
    public record Report(Gate engineering, Gate database, Gate runtime, Gate taskAcceptance) {
        public List<Gate> gates() { return List.of(engineering, database, runtime, taskAcceptance); }
    }
    private static Gate pass() { return new Gate(Status.PASS, "PASS"); }
    private static Gate fail(String code) { return new Gate(Status.FAIL, code); }
    private static Gate unknown(String code) { return new Gate(Status.INCONCLUSIVE, code); }
    private static Report stopped(Gate first) {
        Gate skipped = unknown("PREREQUISITE_NOT_PASSED");
        return new Report(first, skipped, skipped, skipped);
    }
    private static Report inconclusive(String code) {
        Gate gate = unknown(code);
        return new Report(gate, gate, gate, gate);
    }

    private static boolean matches(ProfileDisposition row, SnapshotReference ref) {
        return Objects.equals(row.getApplicationId(), ref.applicationId())
            && Objects.equals(row.getTaskId(), ref.taskId())
            && Objects.equals(row.getRunId(), ref.runId())
            && Objects.equals(row.getBaselineHash(), ref.baselineHash())
            && Objects.equals(row.getBaseSourceRevision(), ref.baseSourceRevision())
            && Objects.equals(row.getCommitHash(), ref.commitHash())
            && Objects.equals(row.getTreeHash(), ref.treeHash());
    }

    public Report validate(SnapshotReference reference, String acceptanceTarget) {
        if (reference == null) return inconclusive("SNAPSHOT_UNAVAILABLE");
        try {
            reference.require(snapshots);
        } catch (BusinessException e) {
            return inconclusive("SNAPSHOT_REJECTED");
        } catch (RuntimeException e) {
            return inconclusive("SNAPSHOT_UNAVAILABLE");
        }
        ProfileDisposition disposition;
        try {
            disposition = dispositions.selectOneById(reference.runId());
        } catch (RuntimeException e) {
            log.warn("Candidate disposition unavailable, runId={}, errorClass={}",
                safeRun(reference), e.getClass().getSimpleName());
            return inconclusive("PROFILE_DISPOSITION_UNAVAILABLE");
        }
        if (disposition == null) return inconclusive("PROFILE_DISPOSITION_MISSING");
        if (!matches(disposition, reference)) return inconclusive("PROFILE_DISPOSITION_MISMATCH");
        if (!"changed".equals(disposition.getDisposition()) && !"unchanged".equals(disposition.getDisposition())) {
            return inconclusive("PROFILE_DISPOSITION_UNCERTAIN");
        }
        Candidate candidate;
        try {
            candidate = load(reference);
        } catch (Rejected e) {
            if ("MIGRATION_REJECTED".equals(e.reason)) {
                Gate skipped = unknown("PREREQUISITE_NOT_PASSED");
                return new Report(skipped, fail(e.reason), skipped, skipped);
            }
            return stopped(fail(e.reason));
        } catch (BusinessException e) {
            return stopped(fail("SNAPSHOT_REJECTED"));
        } catch (Exception e) {
            log.warn("Candidate snapshot unavailable, runId={}, category=source", safeRun(reference));
            return stopped(unknown("SNAPSHOT_UNAVAILABLE"));
        }
        var parsed = TaskAcceptancePlan.parse(acceptanceTarget, mapper);
        DockerClient docker = dockerProvider.getIfAvailable();
        if (docker == null) return stopped(unknown("ISOLATION_UNAVAILABLE"));
        String network = null;
        String db = null;
        String app = null;
        String carrier = null;
        String workspaceVolume = null;
        String stage = "image";
        Report report = stopped(unknown("ISOLATION_UNAVAILABLE"));
        boolean cleanupFailed = false;
        try {
            String image;
            String mysql;
            try {
                image = docker.inspectImageCmd(IMAGE).exec().getId();
                mysql = docker.inspectImageCmd(MYSQL_IMAGE).exec().getId();
            } catch (NotFoundException e) {
                return stopped(unknown("IMAGE_UNAVAILABLE"));
            }
            var labels = docker.inspectImageCmd(image).exec().getConfig().getLabels();
            if (labels == null || !LOCK_SHA.equals(labels.get("com.zdan.paimeng.validation.lock-sha256"))) {
                return stopped(unknown("IMAGE_UNVERIFIED"));
            }
            stage = "network";
            network = docker.createNetworkCmd().withName("validation-" + UUID.randomUUID())
                .withDriver("bridge").withInternal(true).exec().getId();
            String password = UUID.randomUUID().toString().replace("-", "");
            String dbName = "validation-db-" + UUID.randomUUID();
            var dbHost = limits(network, 1024, 1, 128, Map.of(
                "/var/lib/mysql", "rw,noexec,nosuid,size=512m,uid=999,gid=999",
                "/var/run/mysqld", "rw,noexec,nosuid,size=8m,uid=999,gid=999",
                "/tmp", "rw,noexec,nosuid,size=64m,uid=999,gid=999"));
            stage = "database-container";
            db = docker.createContainerCmd(mysql).withName(dbName).withUser("999:999")
                .withHostConfig(dbHost).withLabels(Map.of(LABEL, "candidate-db"))
                .withEnv("MYSQL_ROOT_PASSWORD=" + password, "MYSQL_DATABASE=validation").exec().getId();
            stage = "database-start";
            docker.startContainerCmd(db).exec();
            stage = "database-ready";
            if (!databaseReady(docker, db, password)) {
                report = stopped(unknown("DATABASE_UNAVAILABLE"));
            } else {
                String rootUrl = "mysql://root:" + password + "@" + dbName + ":3306/validation";
                String runtimePassword = UUID.randomUUID().toString().replace("-", "");
                stage = "database-grant";
                if (!grantRuntimeDml(docker, db, password, runtimePassword)) {
                    report = stopped(unknown("DATABASE_GRANT_FAILED"));
                } else {
                    stage = "workspace-volume";
                    workspaceVolume = docker.createVolumeCmd().withName("validation-workspace-" + UUID.randomUUID())
                        .withDriver("local").withDriverOpts(Map.of("type", "tmpfs", "device", "tmpfs",
                            "o", "size=1073741824,uid=1000,gid=1000"))
                        .withLabels(Map.of(LABEL, "candidate-workspace")).exec().getName();
                    stage = "candidate-carrier";
                    var carrierHost = HostConfig.newHostConfig().withNetworkMode("none")
                        .withReadonlyRootfs(false).withPrivileged(false).withCapDrop(Capability.ALL)
                        .withSecurityOpts(List.of("no-new-privileges:true"))
                        .withMemory(512L * 1024 * 1024).withMemorySwap(512L * 1024 * 1024)
                        .withNanoCPUs(1_000_000_000L).withPidsLimit(64L)
                        .withMounts(List.of(workspaceMount(workspaceVolume)));
                    carrier = docker.createContainerCmd(image).withUser("1000:1000").withHostConfig(carrierHost)
                        .withLabels(Map.of(LABEL, "candidate-carrier")).exec().getId();
                    docker.startContainerCmd(carrier).exec();
                    stage = "candidate-copy";
                    docker.copyArchiveToContainerCmd(carrier).withRemotePath("/workspace/app")
                        .withTarInputStream(new ByteArrayInputStream(candidate.archive())).exec();
                    stage = "locked-dependency-copy";
                    if (exec(docker, carrier, 90, List.of(), "cp", "-R", "/opt/validation/node_modules",
                        "/workspace/app/node_modules") != 0) {
                        report = stopped(unknown("DEPENDENCIES_UNAVAILABLE"));
                    } else {
                    String runtimeUrl = "mysql://validation_app:" + runtimePassword + "@" + dbName + ":3306/validation";
                    var appHost = limits(network, 2048, 2, 256, Map.of(
                        "/tmp", "rw,noexec,nosuid,size=268435456,uid=1000,gid=1000"))
                        .withMounts(List.of(workspaceMount(workspaceVolume)));
                    stage = "candidate-container";
                    app = docker.createContainerCmd(image).withUser("1000:1000").withHostConfig(appHost)
                        .withLabels(Map.of(LABEL, "candidate-app"))
                        .withEnv("DATABASE_URL=" + runtimeUrl, "APP_BASE_PATH=/apps/42/", "HOST=127.0.0.1", "PORT=3000",
                            "HOME=/tmp", "PATH=/opt/validation/node_modules/.bin:/usr/local/bin:/usr/bin:/bin")
                        .exec().getId();
                    stage = "candidate-start";
                    docker.startContainerCmd(app).exec();
                    stage = "candidate-gates";
                    if (exec(docker, app, 120, List.of("DATABASE_URL=" + rootUrl), "node", "/opt/validation/runner.mjs", "database") != 0) {
                        report = new Report(unknown("PREREQUISITE_NOT_PASSED"), fail("DATABASE_FAILED"),
                            unknown("PREREQUISITE_NOT_PASSED"), unknown("PREREQUISITE_NOT_PASSED"));
                    } else if (exec(docker, app, 120, List.of(), "node", "/opt/validation/runner.mjs", "engineering") != 0) {
                        report = new Report(fail("ENGINEERING_FAILED"), pass(), unknown("PREREQUISITE_NOT_PASSED"),
                            unknown("PREREQUISITE_NOT_PASSED"));
                    } else {
                        String server = docker.execCreateCmd(app).withWorkingDir("/workspace/app")
                            .withCmd("node", "dist/server/server.js").exec().getId();
                        // Start the app independently; readiness is proven by the bounded HTTP probe.
                        docker.execStartCmd(server).withDetach(true).exec(new ResultCallback.Adapter<Frame>() { });
                        int runtimeExit = exec(docker, app, 45, List.of(), "node", "/opt/validation/runner.mjs", "runtime");
                        Gate runtime = runtimeExit == 0 ? pass() : fail(switch (runtimeExit) {
                            case 21 -> "HEALTH_FAILED";
                            case 22 -> "SUBPATH_FAILED";
                            case 23 -> "API_FAILED";
                            default -> "RUNTIME_FAILED";
                        });
                        if (!runtime.passed()) {
                            var serverState = docker.inspectExecCmd(server).exec();
                            log.warn("Candidate runtime check failed, runId={}, serverRunning={}, serverExitCode={}",
                                safeRun(reference), serverState.isRunning(), serverState.getExitCodeLong());
                        }
                        Gate acceptance = !runtime.passed() ? unknown("PREREQUISITE_NOT_PASSED")
                            : parsed.plan() == null ? unknown(parsed.reasonCode())
                            : exec(docker, app, 60, List.of("VALIDATION_CHECKS=" + acceptanceTarget),
                                "node", "/opt/validation/runner.mjs", "acceptance") == 0
                                ? pass() : fail("ACCEPTANCE_FAILED");
                        report = new Report(pass(), pass(), runtime, acceptance);
                    }
                    }
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            report = stopped(unknown("CANCELLED"));
        } catch (Exception e) {
            log.warn("Candidate validation isolation failed, runId={}, stage={}, errorClass={}",
                safeRun(reference), stage, e.getClass().getSimpleName());
            report = stopped(unknown("ISOLATION_FAILED"));
        } finally {
            if (app != null) cleanupFailed |= !remove(docker, app);
            if (carrier != null) cleanupFailed |= !remove(docker, carrier);
            if (db != null) cleanupFailed |= !remove(docker, db);
            if (network != null) {
                try { docker.removeNetworkCmd(network).exec(); }
                catch (RuntimeException e) { log.error("Validation network cleanup failed", e); cleanupFailed = true; }
            }
            if (workspaceVolume != null) {
                try { docker.removeVolumeCmd(workspaceVolume).exec(); }
                catch (RuntimeException e) {
                    log.error("Validation tmpfs volume cleanup failed, volume={}", workspaceVolume, e);
                    cleanupFailed = true;
                }
            }
        }
        if (cleanupFailed) return new Report(unknown("CLEANUP_FAILED"), unknown("CLEANUP_FAILED"),
            unknown("CLEANUP_FAILED"), unknown("CLEANUP_FAILED"));
        return report;
    }

    private static String safeRun(SnapshotReference ref) { return ref == null ? "missing" : ref.runId(); }
    private static boolean remove(DockerClient docker, String id) {
        try { docker.removeContainerCmd(id).withForce(true).withRemoveVolumes(true).exec(); return true; }
        catch (RuntimeException e) { log.error("Validation container cleanup failed, containerId={}", id, e); return false; }
    }
    private static HostConfig limits(String network, int memoryMb, int cpus, long pids, Map<String, String> tmpfs) {
        long memory = (long) memoryMb * 1024 * 1024;
        return HostConfig.newHostConfig().withNetworkMode(network).withReadonlyRootfs(true)
            .withPrivileged(false).withCapDrop(Capability.ALL).withSecurityOpts(List.of("no-new-privileges:true"))
            .withMemory(memory).withMemorySwap(memory).withNanoCPUs(cpus * 1_000_000_000L)
            .withPidsLimit(pids).withTmpFs(tmpfs);
    }
    private static Mount workspaceMount(String name) {
        return new Mount().withType(MountType.VOLUME).withSource(name)
            .withTarget("/workspace/app").withReadOnly(false);
    }
    private static boolean databaseReady(DockerClient docker, String db, String password) throws InterruptedException {
        long deadline = System.nanoTime() + Duration.ofSeconds(90).toNanos();
        while (System.nanoTime() < deadline) {
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            try {
                if (exec(docker, db, 3, List.of("MYSQL_PWD=" + password), "mysql", "--protocol=tcp",
                    "-h127.0.0.1", "-uroot", "-e", "SELECT 1") == 0) return true;
            } catch (RuntimeException ignored) { /* MySQL entrypoint may still be initializing. */ }
            TimeUnit.MILLISECONDS.sleep(500);
        }
        return false;
    }
    private static boolean grantRuntimeDml(DockerClient docker, String db, String rootPassword,
                                           String runtimePassword) throws InterruptedException {
        String sql = "CREATE USER 'validation_app'@'%' IDENTIFIED BY '" + runtimePassword + "'; "
            + "GRANT SELECT, INSERT, UPDATE, DELETE ON validation.* TO 'validation_app'@'%';";
        return exec(docker, db, 5, List.of("MYSQL_PWD=" + rootPassword), "mysql", "--protocol=tcp",
            "-h127.0.0.1", "-uroot", "--execute=" + sql) == 0;
    }
    private static int exec(DockerClient docker, String id, int seconds, List<String> env, String... command)
        throws InterruptedException {
        var created = docker.execCreateCmd(id).withWorkingDir("/")
            .withEnv(env).withAttachStdout(true).withAttachStderr(true).withCmd(command).exec();
        try (var callback = new ResultCallback.Adapter<Frame>()) {
            docker.execStartCmd(created.getId()).exec(callback);
            if (!callback.awaitCompletion(seconds, TimeUnit.SECONDS)) throw new IllegalStateException("Command timeout");
        } catch (IOException e) { throw new IllegalStateException("Command stream failed", e); }
        Long exit = docker.inspectExecCmd(created.getId()).exec().getExitCodeLong();
        return exit == null ? -1 : exit.intValue();
    }

    private Candidate load(SnapshotReference reference) throws IOException {
        if (reference == null) throw new Rejected("SNAPSHOT_REJECTED");
        reference.require(snapshots);
        var identity = new CandidateGitStore.GitIdentity(reference.commitHash(), reference.treeHash());
        git.verify(reference.applicationId(), reference.runId(), identity);
        Process process = git.archive(reference.applicationId(), identity);
        Map<String, String> found = new HashMap<>();
        Set<String> names = new HashSet<>();
        int count = 0;
        long bytes = 0;
        int migrations = 0;
        boolean schemaSeen = false;
        try (InputStream input = process.getInputStream();
             TarArchiveInputStream tar = new TarArchiveInputStream(input);
             ByteArrayOutputStream buffer = new ByteArrayOutputStream();
             TarArchiveOutputStream clean = new TarArchiveOutputStream(buffer)) {
            TarArchiveEntry entry;
            while ((entry = tar.getNextEntry()) != null) {
                String name = entry.getName();
                if (name == null) throw new Rejected("SNAPSHOT_REJECTED");
                String normalized = entry.isDirectory() && name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
                if (name.isEmpty() || name.length() > 1024 || name.startsWith("/")
                    || name.indexOf('\\') >= 0 || name.chars().anyMatch(ch -> ch < 32 || ch == 127)
                    || !names.add(normalized) || ++count > 4096 || entry.getSize() < 0
                    || (bytes += entry.getSize()) > MAX_BYTES || (entry.getMode() & 07000) != 0
                    || entry.isSymbolicLink() || entry.isLink() || entry.isSparse() || entry.isGNUSparse()
                    || !(entry.isFile() || entry.isDirectory())) throw new Rejected("SNAPSHOT_REJECTED");
                String[] parts = name.split("/", -1);
                for (int i = 0; i < parts.length; i++) {
                    String part = parts[i];
                    if (part.isEmpty() && i == parts.length - 1 && entry.isDirectory()) continue;
                    if (part.isEmpty() || part.equals(".") || part.equals("..")
                        || (part.startsWith(".env") && !(name.equals(".env.example") && i == 0))
                        || part.equals("node_modules") || part.equals("dist") || part.startsWith(".git")
                        || part.equals(".npmrc") || part.equals(".pnpmfile.cjs"))
                        throw new Rejected("SNAPSHOT_REJECTED");
                }
                if ((name.startsWith("prisma/migrations/") && name.endsWith("/migration.sql"))) {
                    if (!name.matches("prisma/migrations/[A-Za-z0-9_-]{1,128}/migration\\.sql")
                        || entry.getSize() > 65536 || ++migrations > 64) throw new Rejected("SNAPSHOT_REJECTED");
                }
                byte[] content = entry.isFile() ? tar.readNBytes((int) entry.getSize()) : new byte[0];
                if (content.length != entry.getSize()) throw new Rejected("SNAPSHOT_REJECTED");
                if (name.equals(".env.example")
                    && !"924e1359543dcc25850c3409c6633b8009cd3dddc54cbc867610d79d3567988a".equals(sha(content)))
                    throw new Rejected("CANDIDATE_CONFIG_REJECTED");
                if (PINNED.containsKey(name)) found.put(name, sha(content));
                if (name.equals("prisma/schema.prisma")) {
                    schemaSeen = true;
                    String schema = new String(content, StandardCharsets.UTF_8);
                    if (!schema.startsWith(SCHEMA_HEADER)
                        || java.util.regex.Pattern.compile("(?m)^\\s*(generator|datasource)\\s+\\w+")
                            .matcher(schema.substring(SCHEMA_HEADER.length())).find())
                        throw new Rejected("CANDIDATE_CONFIG_REJECTED");
                }
                if (name.endsWith("/migration.sql")) {
                    if (!name.startsWith("prisma/migrations/")
                        || !migrationGate.evaluate(new String(content, StandardCharsets.UTF_8)).allowed())
                        throw new Rejected("MIGRATION_REJECTED");
                }
                if ((name.endsWith(".config.js") || name.endsWith(".config.ts")
                    || name.endsWith(".config.mjs") || name.startsWith("tsconfig")) && !PINNED.containsKey(name))
                    throw new Rejected("CANDIDATE_CONFIG_REJECTED");
                TarArchiveEntry output = new TarArchiveEntry(name);
                output.setSize(content.length);
                output.setMode(entry.isDirectory() ? 0755 : 0644);
                clean.putArchiveEntry(output);
                if (entry.isFile()) clean.write(content);
                clean.closeArchiveEntry();
            }
            clean.finish();
            if (!process.waitFor(30, TimeUnit.SECONDS) || process.exitValue() != 0) throw new Rejected("SNAPSHOT_REJECTED");
            if (!found.equals(PINNED) || !schemaSeen) throw new Rejected("CANDIDATE_CONFIG_REJECTED");
            if (migrations == 0) throw new Rejected("MIGRATION_REJECTED");
            return new Candidate(buffer.toByteArray());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Git archive interrupted", e);
        } finally { process.destroyForcibly(); }
    }
    private static String sha(byte[] data) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private record Candidate(byte[] archive) { }
    private static final class Rejected extends RuntimeException {
        private final String reason;
        private Rejected(String reason) { this.reason = reason; }
    }
}
