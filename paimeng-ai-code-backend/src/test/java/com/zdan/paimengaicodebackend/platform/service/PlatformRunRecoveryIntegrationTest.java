package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.exception.NotFoundException;
import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunCommandRequestMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunLeaseMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunRecoveryCheckpointMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskState;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** AC-3: same-Run recovery is real only before the first Pi/tool request. */
@SpringBootTest(properties = {"platform.sandbox.enabled=true", "platform.execution.enabled=true"})
class PlatformRunRecoveryIntegrationTest {

    private static final Path SNAPSHOT_ROOT = snapshotRoot();

    @DynamicPropertySource
    static void snapshotProperties(DynamicPropertyRegistry properties) {
        properties.add("platform.snapshot.repo-root", SNAPSHOT_ROOT::toString);
    }

    @AfterAll
    static void removeTestGitRoot() throws IOException {
        try (var paths = Files.walk(SNAPSHOT_ROOT)) {
            for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
        }
    }

    private static Path snapshotRoot() {
        try {
            return Files.createTempDirectory("issue78-snapshot-test-");
        } catch (IOException e) {
            throw new IllegalStateException("Cannot create test Git root", e);
        }
    }

    private static final String BASELINE_JSON = "{\"schemaVersion\":1,\"baseProfileVersion\":null,"
        + "\"baseSourceRevision\":null,\"requestedOutcome\":\"Build app\","
        + "\"acceptanceTarget\":\"Works\"}";

    @Autowired private AppMapper appMapper;
    @Autowired private PlatformRequirementMapper requirementMapper;
    @Autowired private PlatformTaskMapper taskMapper;
    @Autowired private PlatformRunMapper runMapper;
    @Autowired private PlatformRunLeaseMapper leaseMapper;
    @Autowired private PlatformRunRecoveryCheckpointMapper checkpointMapper;
    @Autowired private PlatformRunCommandRequestMapper commandMapper;
    @Autowired private PlatformRunExecutionService executionService;
    @Autowired private PlatformRunRecoveryService recoveryService;
    @Autowired private PlatformRunLeaseService leaseService;
    @Autowired private PlatformRunTransitionService transitionService;
    @Autowired private PlatformSandboxExecutor sandboxExecutor;
    @Autowired private PlatformSandboxProperties sandboxProperties;
    @Autowired private DockerClient dockerClient;

    private final List<Graph> created = new ArrayList<>();

    @BeforeEach
    void requireDockerAndImage() {
        try {
            dockerClient.pingCmd().exec();
            dockerClient.inspectImageCmd(sandboxProperties.getImageReference()).exec();
        } catch (NotFoundException missingImage) {
            assumeTrue(false, "Sandbox image unavailable for AC-3 container test");
        } catch (RuntimeException unavailableDocker) {
            assumeTrue(false, "Docker unavailable for AC-3 container test");
        }
    }

    @AfterEach
    void cleanUpSyntheticResources() {
        for (Graph graph : created) {
            sandboxExecutor.find(graph.runId()).ifPresent(sandboxExecutor::stop);
            PlatformRunLease lease = leaseMapper.selectOneByQuery(
                QueryWrapper.create().eq("appId", graph.applicationId())
            );
            if (lease != null) {
                String cleanupRequestId = "synthetic-cleanup-" + UUID.randomUUID();
                if (lease.getExpiresAt().isBefore(LocalDateTime.now())) {
                    assertThrows(BusinessException.class, () -> leaseService.requireHeldLease(
                        graph.runId(), lease.getFenceToken(), cleanupRequestId
                    ));
                } else {
                    leaseService.release(graph.runId(), lease.getFenceToken(),
                        PlatformActor.PLATFORM, "SYNTHETIC_TEST_CLEANUP", cleanupRequestId);
                }
            }
            PlatformRun run = runMapper.selectOneById(graph.runId());
            PlatformRunState state = PlatformRunState.valueOf(run.getState());
            if (state == PlatformRunState.LEASED || state == PlatformRunState.EXECUTING) {
                transitionService.transition(graph.runId(), state, PlatformRunState.FAILED,
                    PlatformActor.PLATFORM, "SYNTHETIC_TEST_CLEANUP", null,
                    "synthetic-run-cleanup-" + UUID.randomUUID());
            }
            App softDeleted = new App();
            softDeleted.setId(graph.applicationId());
            softDeleted.setIsDelete(1);
            appMapper.update(softDeleted);
        }
        created.clear();
    }

    @Test
    void expiredLeaseWithOriginalEmptyContainerAndNoRequestsResumesSameRun() {
        Graph graph = createGraph();
        var first = grant(graph, "initial-grant");
        var original = sandboxExecutor.find(graph.runId()).orElseThrow();
        assertThrows(BusinessException.class, () -> executionService.execute(
            graph.appIdText(), graph.runId(), first.getLease().getFenceToken(),
            "touch /workspace/not-allowed", 5, "command-before-prepare"
        ));
        assertEquals(PlatformRunState.LEASED.name(), runMapper.selectOneById(graph.runId()).getState());
        assertEquals(0, commandMapper.selectCountByQuery(QueryWrapper.create().eq("runId", graph.runId())));
        sandboxExecutor.requirePristineWorkspace(original);
        executionService.prepareRecovery(graph.appIdText(), graph.runId(),
            first.getLease().getFenceToken(), "prepare-initial");

        // Lease still active: no second owner. Before begin, commands cannot mutate Workspace.
        assertThrows(BusinessException.class, () -> grant(graph, "active-lease"));
        assertThrows(BusinessException.class, () -> executionService.execute(
            graph.appIdText(), graph.runId(), first.getLease().getFenceToken(),
            "touch /workspace/not-allowed", 5, "command-before-begin"
        ));
        assertEquals(PlatformRunState.LEASED.name(), runMapper.selectOneById(graph.runId()).getState());
        assertEquals(0, commandMapper.selectCountByQuery(QueryWrapper.create().eq("runId", graph.runId())));

        expire(graph.runId());
        var resumed = grant(graph, "restart-grant");
        long freshFence = resumed.getLease().getFenceToken();
        assertTrue(freshFence > first.getLease().getFenceToken());
        assertEquals(original.containerId(), sandboxExecutor.find(graph.runId()).orElseThrow().containerId());
        assertEquals("PREPARED", checkpointMapper.selectOneById(graph.runId()).getPhase());
        assertEquals(freshFence, checkpointMapper.selectOneById(graph.runId()).getFenceToken());
        assertThrows(BusinessException.class, () -> executionService.beginExecution(
            graph.appIdText(), graph.runId(), first.getLease().getFenceToken(), "old-process-begin"
        ));

        executionService.prepareRecovery(graph.appIdText(), graph.runId(), freshFence, "prepare-resumed");
        executionService.beginExecution(graph.appIdText(), graph.runId(), freshFence, "begin-resumed");
        assertEquals("STARTED", checkpointMapper.selectOneById(graph.runId()).getPhase());
        assertEquals(PlatformRunState.EXECUTING.name(), runMapper.selectOneById(graph.runId()).getState());

        String sideEffect = "printf x >> /workspace/once";
        executionService.execute(graph.appIdText(), graph.runId(), freshFence, sideEffect, 5, "command-once");
        assertThrows(BusinessException.class, () -> executionService.execute(
            graph.appIdText(), graph.runId(), freshFence, sideEffect, 5, "command-once"
        ));
        var readBack = executionService.execute(
            graph.appIdText(), graph.runId(), freshFence, "cat /workspace/once", 5, "command-read"
        );
        assertEquals("x", readBack.getStdout());
        assertEquals(1, commandMapper.selectCountByQuery(
            QueryWrapper.create().eq("runId", graph.runId()).eq("requestId", "command-once")
        ));

        executionService.freeze(graph.appIdText(), graph.runId(), freshFence, "freeze-done");
        executionService.reportResult(
            graph.appIdText(), graph.runId(), freshFence, "SUCCEEDED", "TEST_DONE", null, "report-done"
        );
        assertEquals(PlatformRunState.SUCCEEDED.name(), runMapper.selectOneById(graph.runId()).getState());
        assertTrue(sandboxExecutor.find(graph.runId()).isEmpty());
        assertEquals(0, leaseMapper.selectCountByQuery(QueryWrapper.create().eq("runId", graph.runId())));
    }

    @Test
    void historicalLeasedRunWithoutCheckpointCannotBeReclaimed() {
        Graph graph = createGraph();
        grant(graph, "initial-grant");
        expire(graph.runId());
        assertThrows(BusinessException.class, () -> grant(graph, "unmarked-restart"));
        assertEquals(0, checkpointMapper.selectCountByQuery(QueryWrapper.create().eq("runId", graph.runId())));
    }

    @Test
    void unconfirmedCommandRequestCannotBeExecutedAgainWithTheSameKey() {
        Graph graph = createGraph();
        var lease = grant(graph, "initial-grant").getLease();
        executionService.prepareRecovery(graph.appIdText(), graph.runId(),
            lease.getFenceToken(), "prepare-initial");
        executionService.beginExecution(graph.appIdText(), graph.runId(),
            lease.getFenceToken(), "begin-initial");
        recoveryService.startCommand(graph.applicationId(), graph.runId(),
            lease.getFenceToken(), "printf x", "uncertain-command");

        assertThrows(BusinessException.class, () -> executionService.execute(
            graph.appIdText(), graph.runId(), lease.getFenceToken(),
            "printf x", 5, "uncertain-command"
        ));
        assertEquals(1, commandMapper.selectCountByQuery(QueryWrapper.create()
            .eq("runId", graph.runId()).eq("requestId", "uncertain-command")
        ));
    }

    @Test
    void legacyRuntimeCannotResumeEvenWhenARecoverableCheckpointExists() {
        Graph graph = createGraph();
        var first = grant(graph, "initial-grant");
        executionService.prepareRecovery(graph.appIdText(), graph.runId(),
            first.getLease().getFenceToken(), "prepare-initial");
        expire(graph.runId());
        assertThrows(BusinessException.class, () -> executionService.grantLease(
            graph.appIdText(), graph.runId(), "LEGACY_RUNTIME", "legacy-restart"
        ));
        assertEquals(first.getLease().getFenceToken(),
            checkpointMapper.selectOneById(graph.runId()).getFenceToken());
    }

    @Test
    void startedModelRequestCannotBeReclaimedEvenAfterLeaseExpiry() {
        Graph graph = createGraph();
        var first = grant(graph, "initial-grant");
        executionService.prepareRecovery(graph.appIdText(), graph.runId(),
            first.getLease().getFenceToken(), "prepare-initial");
        executionService.beginExecution(graph.appIdText(), graph.runId(),
            first.getLease().getFenceToken(), "begin-initial");
        expire(graph.runId());
        assertThrows(BusinessException.class, () -> grant(graph, "started-restart"));
    }

    @Test
    void missingContainerOrChangedWorkspaceCannotBeReclaimed() {
        Graph missing = createGraph();
        var first = grant(missing, "initial-grant");
        executionService.prepareRecovery(missing.appIdText(), missing.runId(),
            first.getLease().getFenceToken(), "prepare-initial");
        sandboxExecutor.stop(sandboxExecutor.find(missing.runId()).orElseThrow());
        expire(missing.runId());
        assertThrows(BusinessException.class, () -> grant(missing, "missing-container"));

        Graph changed = createGraph();
        var second = grant(changed, "initial-grant");
        var handle = sandboxExecutor.find(changed.runId()).orElseThrow();
        executionService.prepareRecovery(changed.appIdText(), changed.runId(),
            second.getLease().getFenceToken(), "prepare-initial");
        assertEquals(0, sandboxExecutor.exec(
            handle, "touch /workspace/external-change", 5, ignored -> { }, ignored -> { }
        ));
        expire(changed.runId());
        assertThrows(BusinessException.class, () -> grant(changed, "changed-workspace"));
    }

    private com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseGrantVO grant(Graph graph, String requestId) {
        return executionService.grantLease(graph.appIdText(), graph.runId(), "TEST_EXECUTION", requestId, 1);
    }

    private void expire(String runId) {
        PlatformRunLease update = new PlatformRunLease();
        update.setExpiresAt(LocalDateTime.now().minusSeconds(1));
        assertEquals(1, leaseMapper.updateByQuery(update, true, QueryWrapper.create().eq("runId", runId)));
    }

    private Graph createGraph() {
        App application = new App();
        application.setUserId(1L);
        application.setAppName("synthetic AC-3 recovery application");
        application.setCodeGenType("html");
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        appMapper.insertSelective(application);

        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(application.getId());
        requirement.setKind("OWNER_REQUEST");
        requirement.setOriginalText("synthetic recovery requirement");
        requirementMapper.insertSelective(requirement);

        PlatformTask task = new PlatformTask();
        task.setApplicationId(application.getId());
        task.setRequirementId(requirement.getId());
        task.setState(PlatformTaskState.CREATED.name());
        task.setBaselineJson(BASELINE_JSON);
        taskMapper.insertSelective(task);

        PlatformRun run = new PlatformRun();
        run.setId("run-recovery-" + UUID.randomUUID());
        run.setApplicationId(application.getId());
        run.setTaskId(task.getId());
        run.setState(PlatformRunState.CREATED.name());
        run.setAttemptNumber(1);
        runMapper.insertSelective(run);

        Graph graph = new Graph(application.getId(), run.getId());
        created.add(graph);
        return graph;
    }

    private record Graph(Long applicationId, String runId) {
        String appIdText() { return applicationId.toString(); }
    }
}
