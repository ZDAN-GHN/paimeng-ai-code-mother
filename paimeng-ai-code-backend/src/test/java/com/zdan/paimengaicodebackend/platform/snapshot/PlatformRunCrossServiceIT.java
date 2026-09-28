package com.zdan.paimengaicodebackend.platform.snapshot;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.github.dockerjava.api.DockerClient;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.CandidateSourceSnapshotMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.ValidationEvidenceMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import java.io.IOException;
import java.sql.SQLException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.core.env.Environment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** Explicit opt-in HTTP acceptance test; never touches a default datasource or shared Redis. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"server.address=127.0.0.1", "platform.execution.enabled=true",
        "platform.sandbox.enabled=true"})
class PlatformRunCrossServiceIT {
    private static final String BASELINE_JSON = "{\"schemaVersion\":1,\"baseProfileVersion\":null,"
        + "\"baseSourceRevision\":null,\"requestedOutcome\":\"Create an intake page\","
        + "\"acceptanceTarget\":\"The page has a heading\"}";
    private static Path gitRoot;

    @DynamicPropertySource
    static void isolatedConfiguration(DynamicPropertyRegistry properties) throws IOException {
        String db = System.getenv("SPRING_DATASOURCE_URL");
        String flyway = System.getenv("SPRING_FLYWAY_URL");
        String redisPort = System.getenv("SPRING_DATA_REDIS_PORT");
        if (!"1".equals(System.getenv("ISSUE78_HTTP_E2E"))
            || !Boolean.getBoolean("issue78.agent.isolated") || db == null || !db.equals(flyway)
            || !db.matches("jdbc:mysql://127\\.0\\.0\\.1:(?!3306)\\d+/paimeng_ai_code_mother")
            || !"issue78_java".equals(System.getenv("SPRING_DATASOURCE_USERNAME"))
            || System.getenv("SPRING_DATASOURCE_PASSWORD") == null
            || System.getenv("SPRING_FLYWAY_USER") == null
            || System.getenv("SPRING_FLYWAY_PASSWORD") == null
            || redisPort == null || !redisPort.matches("(?!6379)\\d+")) {
            throw new IllegalStateException("Cross-service test requires explicit isolated MySQL and Redis");
        }
        gitRoot = Files.createTempDirectory("issue78-http-git-");
        properties.add("spring.datasource.url", () -> db);
        properties.add("spring.datasource.username", () -> System.getenv("SPRING_DATASOURCE_USERNAME"));
        properties.add("spring.datasource.password", () -> System.getenv("SPRING_DATASOURCE_PASSWORD"));
        properties.add("spring.flyway.url", () -> flyway);
        properties.add("spring.flyway.user", () -> System.getenv("SPRING_FLYWAY_USER"));
        properties.add("spring.flyway.password", () -> System.getenv("SPRING_FLYWAY_PASSWORD"));
        properties.add("spring.data.redis.host", () -> "127.0.0.1");
        properties.add("spring.data.redis.port", () -> redisPort);
        properties.add("platform.snapshot.repo-root", gitRoot::toString);
    }

    @AfterAll
    static void cleanGit() throws IOException {
        if (gitRoot == null) return;
        try (var paths = Files.walk(gitRoot)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }

    @Autowired private AppMapper apps;
    @Autowired private PlatformRequirementMapper requirements;
    @Autowired private PlatformTaskMapper tasks;
    @Autowired private PlatformRunMapper runs;
    @Autowired private CandidateSourceSnapshotMapper snapshots;
    @Autowired private CandidateSnapshotService snapshotService;
    @Autowired private ProfileDispositionService profileService;
    @Autowired private ValidationEvidenceService validationService;
    @Autowired private ValidationEvidenceMapper evidenceRows;
    @Autowired private CandidateGitStore git;
    @Autowired private DataSource dataSource;
    @Autowired private Environment environment;
    @Autowired private PlatformRunLeaseMapper activeLeases;
    @Autowired private PlatformRunLeaseService leaseService;
    @Autowired private PlatformRunTransitionService transitions;
    @Autowired private PlatformSandboxExecutor sandbox;
    @Autowired private PlatformSandboxProperties sandboxProperties;
    @Autowired private DockerClient docker;
    @LocalServerPort private int port;
    @TempDir Path logs;

    private final List<Fixture> created = new ArrayList<>();

    @BeforeEach
    void requireLocalPrerequisites() throws SQLException {
        assertEquals(System.getenv("SPRING_FLYWAY_URL"), environment.getProperty("spring.flyway.url"));
        assertEquals("127.0.0.1", environment.getProperty("spring.data.redis.host"));
        assertEquals(System.getenv("SPRING_DATA_REDIS_PORT"), environment.getProperty("spring.data.redis.port"));
        try (var connection = dataSource.getConnection()) {
            assertEquals(System.getenv("SPRING_DATASOURCE_URL"),
                connection.getMetaData().getURL().split("\\?", 2)[0]);
            assertEquals("paimeng_ai_code_mother", connection.getCatalog());
            assertTrue(connection.getMetaData().getUserName().startsWith("issue78_java@"));
        }
        Path agent = Path.of("../paimeng-ai-code-agent").toAbsolutePath().normalize();
        assertTrue(Files.isRegularFile(agent.resolve("node_modules/.bin/tsx")), "Agent dependencies unavailable");
        assertTrue(Files.isRegularFile(agent.resolve("test/integration/issue78Http.integration.ts")),
            "Cross-service test script unavailable");
        assertDoesNotThrow(() -> docker.inspectImageCmd(sandboxProperties.getImageReference()).exec());
    }

    @AfterEach
    void cleanSyntheticRuns() {
        for (Fixture fixture : created) {
            sandbox.find(fixture.runId()).ifPresent(sandbox::stop);
            PlatformRunLease lease = activeLeases.selectOneByQuery(
                com.mybatisflex.core.query.QueryWrapper.create().eq("runId", fixture.runId()));
            if (lease != null && lease.getExpiresAt().isAfter(LocalDateTime.now())) {
                leaseService.release(fixture.runId(), lease.getFenceToken(), PlatformActor.PLATFORM,
                    "SYNTHETIC_TEST_CLEANUP", "cleanup-" + UUID.randomUUID());
            }
            PlatformRun run = runs.selectOneById(fixture.runId());
            PlatformRunState state = PlatformRunState.valueOf(run.getState());
            if (state == PlatformRunState.LEASED || state == PlatformRunState.EXECUTING) {
                transitions.transition(fixture.runId(), state, PlatformRunState.FAILED,
                    PlatformActor.PLATFORM, "SYNTHETIC_TEST_CLEANUP", null,
                    "cleanup-run-" + UUID.randomUUID());
            }
            App archived = new App();
            archived.setId(fixture.appId());
            archived.setIsDelete(1);
            apps.update(archived);
        }
        created.clear();
    }

    @Test
    void realRuntimeHttpFreezeResultAndRestore() throws Exception {
        Fixture success = fixture();
        runAgent(success, "success");
        assertEquals(0, evidenceRows.selectCountByQuery(QueryWrapper.create().eq("runId", success.runId())));
        assertEquals("SUCCEEDED", runs.selectOneById(success.runId()).getState());
        var stored = snapshotService.requireReady(success.appId(), success.runId());
        assertEquals(success.taskId(), stored.getTaskId());
        assertEquals(CandidateGitStore.sha256(tasks.selectOneById(success.taskId()).getBaselineJson()),
            stored.getBaselineHash());
        assertNotNull(stored.getCommitHash());
        assertTrue(sandbox.find(success.runId()).isEmpty());

        SnapshotReference reference = new SnapshotReference(success.appId(), success.taskId(),
            success.runId(), stored.getBaselineHash(), stored.getBaseSourceRevision(),
            stored.getCommitHash(), stored.getTreeHash());
        assertThrows(BusinessException.class, () -> profileService.record(
            reference, "changed", null, success.requirementId(), "missing diff"));
        var profile = profileService.record(reference, "changed", "{\"added\":[\"intake\"]}",
            success.requirementId(), "synthetic profile change");
        assertEquals(stored.getCommitHash(), profile.getCommitHash());
        assertThrows(BusinessException.class, () -> validationService.record(reference, "BUILD", "PASS",
            "{\"status\":\"ok\"}", null, "invalid-artifact"));
        var artifact = git.persistEvidence(reference, "integration-build", new byte[]{0, 1, (byte) 255});
        var evidence = validationService.record(reference, "BUILD", "PASS",
            "{\"status\":\"ok\"}", artifact, "integration-build");
        assertEquals(artifact.ref(), evidence.getArtifactRef());
        assertEquals(1, evidenceRows.selectCountByQuery(QueryWrapper.create().eq("runId", success.runId())));
        assertEquals(evidence.getId(), validationService.record(reference, "BUILD", "PASS",
            "{\"status\":\"ok\"}", artifact, "integration-build").getId());
        assertThrows(BusinessException.class, () -> validationService.record(
            new SnapshotReference(success.appId(), success.taskId() + 1, success.runId(),
                reference.baselineHash(), reference.baseSourceRevision(),
                reference.commitHash(), reference.treeHash()),
            "BUILD", "PASS", "{\"status\":\"ok\"}", artifact, "wrong-owner"));

        var restored = sandbox.start(success.runId(), success.appId());
        try {
            snapshotService.restore(success.appId(), success.runId(), restored);
            StringBuilder content = new StringBuilder();
            assertEquals(0, sandbox.exec(restored, "cat /workspace/index.html", 10,
                bytes -> content.append(new String(bytes, StandardCharsets.UTF_8)), ignored -> { }));
            assertEquals("<h1>Issue 78 integration</h1>", content.toString());
        } finally {
            sandbox.stop(restored);
        }

        Fixture failed = fixture();
        runAgent(failed, "empty-workspace");
        assertEquals("FAILED", runs.selectOneById(failed.runId()).getState());
        assertEquals("ABORTED", snapshots.selectOneById(failed.runId()).getStatus());
        assertThrows(BusinessException.class, () -> snapshotService.requireReady(failed.appId(), failed.runId()));
        assertTrue(sandbox.find(failed.runId()).isEmpty());
        assertFalse(Files.exists(gitRoot.resolve("app-" + failed.appId() + ".git")));
    }

    private void runAgent(Fixture fixture, String mode) throws Exception {
        Path agent = Path.of("../paimeng-ai-code-agent").toAbsolutePath().normalize();
        Path output = logs.resolve(mode + ".log");
        String container = "issue78-agent-" + UUID.randomUUID();
        List<String> command = new ArrayList<>(List.of(
            "docker", "run", "--rm", "--name", container, "--network", "host",
                "--user", "11001:11001", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "512m",
                "--tmpfs", "/tmp", "--workdir", "/opt/agent",
                "--env", "HOME=/tmp", "--env", "ISSUE78_ISOLATED=1",
                "--env", "ISSUE78_GIT_ROOT=" + gitRoot,
                "--mount", "type=bind,source=" + agent.resolve("src") + ",target=/opt/agent/src,readonly",
                "--mount", "type=bind,source=" + agent.resolve("test") + ",target=/opt/agent/test,readonly",
                "--mount", "type=bind,source=" + agent.resolve("node_modules")
                    + ",target=/opt/agent/node_modules,readonly",
                "--mount", "type=bind,source=" + agent.resolve("package.json")
                    + ",target=/opt/agent/package.json,readonly",
                "--mount", "type=bind,source=" + agent.resolve("tsconfig.json")
                    + ",target=/opt/agent/tsconfig.json,readonly",
                "paimeng-ai-code-sandbox:0.1.0", "node", "/opt/agent/node_modules/tsx/dist/cli.mjs"));
        command.addAll(List.of("test/integration/issue78Http.integration.ts",
            "http://127.0.0.1:" + port + "/api", fixture.appId().toString(), fixture.runId(), mode));
        Process process = new ProcessBuilder(command).directory(agent.toFile())
            .redirectErrorStream(true).redirectOutput(output.toFile()).start();
        try {
            if (!process.waitFor(120, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                throw new IllegalStateException("Cross-service Runtime timed out");
            }
            assertEquals(0, process.exitValue(), Files.readString(output));
        } finally {
            process.destroyForcibly();
            Process cleanup = new ProcessBuilder("docker", "rm", "-f", container)
                .redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
            if (!cleanup.waitFor(15, TimeUnit.SECONDS)) cleanup.destroyForcibly();
        }
    }

    private Fixture fixture() {
        App app = new App();
        app.setUserId(1L);
        app.setAppName("synthetic issue78 HTTP acceptance");
        app.setCodeGenType("html");
        app.setIsDelete(0);
        app.setLifecycleStatus("ACTIVE");
        apps.insertSelective(app);
        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(app.getId());
        requirement.setKind("OWNER_REQUEST");
        requirement.setOriginalText("synthetic issue78 request");
        requirements.insertSelective(requirement);
        PlatformTask task = new PlatformTask();
        task.setApplicationId(app.getId());
        task.setRequirementId(requirement.getId());
        task.setState("CREATED");
        task.setBaselineJson(BASELINE_JSON);
        tasks.insertSelective(task);
        PlatformRun run = new PlatformRun();
        run.setId("issue78-http-" + UUID.randomUUID());
        run.setApplicationId(app.getId());
        run.setTaskId(task.getId());
        run.setState("CREATED");
        run.setAttemptNumber(1);
        runs.insertSelective(run);
        Fixture fixture = new Fixture(app.getId(), task.getId(), requirement.getId(), run.getId());
        created.add(fixture);
        return fixture;
    }

    private record Fixture(Long appId, Long taskId, Long requirementId, String runId) { }
}
