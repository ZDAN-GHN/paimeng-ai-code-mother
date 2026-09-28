package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.domain.TaskExecutionBaselineCodec;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunRecoveryCheckpoint;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunCommandResultVO;
import java.time.LocalDateTime;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

/**
 * 受控执行编排的正确性（Issue #77 / T-05，计划步骤 29）。
 *
 * <p>这些断言针对的是<strong>顺序</strong>与<strong>拒绝</strong>，不是数据库行为：
 * 编排顺序由 Run 状态机的前置条件钉死（终态转换要求已无 Lease 行），顺序错了功能会在真实
 * 状态机下失败而非静默降级。Lease 与审计的库层事实由
 * {@code PlatformRunLeaseAuditIntegrationTest} 覆盖。
 */
class PlatformRunExecutionServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final String APPLICATION_ID_TEXT = "460017668615995392";
    private static final String RUN_ID = "run-7001";
    private static final long TASK_ID = 9001L;
    private static final long FENCE_TOKEN = 3L;
    private static final String BASELINE_JSON = "{\"schemaVersion\":1,\"baseProfileVersion\":null,"
        + "\"baseSourceRevision\":null,\"requestedOutcome\":\"Build app\","
        + "\"acceptanceTarget\":\"Works\"}";

    private PlatformRunLeaseService leaseService;
    private PlatformRunTransitionService runTransitionService;
    private PlatformLogicalRelationValidator relationValidator;
    private PlatformSandboxExecutor sandboxExecutor;
    private PlatformSandboxProperties sandboxProperties;
    private PlatformRunMapper runMapper;
    private PlatformTaskMapper taskMapper;
    private TaskExecutionBaselineCodec baselineCodec;
    private PlatformRunRecoveryService recoveryService;
    private CandidateSnapshotService snapshotService;
    private PlatformRunExecutionService executionService;

    @BeforeEach
    void setUp() {
        leaseService = mock(PlatformRunLeaseService.class);
        runTransitionService = mock(PlatformRunTransitionService.class);
        relationValidator = mock(PlatformLogicalRelationValidator.class);
        sandboxExecutor = mock(PlatformSandboxExecutor.class);
        sandboxProperties = new PlatformSandboxProperties();
        runMapper = mock(PlatformRunMapper.class);
        taskMapper = mock(PlatformTaskMapper.class);
        baselineCodec = mock(TaskExecutionBaselineCodec.class);
        recoveryService = mock(PlatformRunRecoveryService.class);
        snapshotService = mock(CandidateSnapshotService.class);
        PlatformRun run = new PlatformRun();
        run.setId(RUN_ID);
        run.setApplicationId(APPLICATION_ID);
        run.setTaskId(TASK_ID);
        run.setState(PlatformRunState.CREATED.name());
        when(runMapper.selectOneById(RUN_ID)).thenReturn(run);
        PlatformTask task = new PlatformTask();
        task.setId(TASK_ID);
        task.setApplicationId(APPLICATION_ID);
        task.setBaselineJson(BASELINE_JSON);
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(task);
        executionService = new PlatformRunExecutionService(
            leaseService,
            runTransitionService,
            relationValidator,
            sandboxExecutor,
            sandboxProperties,
            runMapper,
            taskMapper,
            baselineCodec,
            recoveryService,
            snapshotService
        );
    }

    @Test
    void grantAcquiresLeaseBeforeTransitionAndSandboxStart() {
        when(leaseService.grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString()))
            .thenReturn(lease());

        var grant = executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-1");
        assertEquals(BASELINE_JSON, grant.getBaselineJson());

        // 顺序由状态机决定：先有 Lease 才能进 LEASED，Sandbox 是最后的外部副作用
        InOrder order = inOrder(relationValidator, leaseService, runTransitionService, sandboxExecutor);
        order.verify(relationValidator).requireRunBelongsToApplication(APPLICATION_ID, RUN_ID);
        order.verify(leaseService).grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString());
        order.verify(runTransitionService).transition(
            eq(RUN_ID),
            eq(PlatformRunState.CREATED),
            eq(PlatformRunState.LEASED),
            eq(PlatformActor.PLATFORM),
            anyString(),
            any(),
            anyString()
        );
        order.verify(sandboxExecutor).start(RUN_ID, APPLICATION_ID);
    }

    @Test
    void missingBaselineCannotAcquireLeaseOrStartSandbox() {
        PlatformTask task = new PlatformTask();
        task.setId(TASK_ID);
        task.setApplicationId(APPLICATION_ID);
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(task);

        assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-1")
        );
        verify(leaseService, never()).grant(anyString(), any(), anyString(), anyString());
        verify(sandboxExecutor, never()).start(anyString(), anyLong());
    }

    @Test
    void restartingAnExecutingRunCannotAcquireALeaseOrCreateANewWorkspace() {
        PlatformRun executing = new PlatformRun();
        executing.setId(RUN_ID);
        executing.setApplicationId(APPLICATION_ID);
        executing.setTaskId(TASK_ID);
        executing.setState(PlatformRunState.EXECUTING.name());
        when(runMapper.selectOneById(RUN_ID)).thenReturn(executing);

        assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-restart")
        );
        verify(leaseService, never()).grant(anyString(), any(), anyString(), anyString());
        verify(sandboxExecutor, never()).start(anyString(), anyLong());
    }

    @Test
    void losingRecoveryClaimReleasesTheNewLeaseWithoutStartingAnotherContainer() {
        PlatformRun leased = new PlatformRun();
        leased.setId(RUN_ID);
        leased.setApplicationId(APPLICATION_ID);
        leased.setTaskId(TASK_ID);
        leased.setState(PlatformRunState.LEASED.name());
        when(runMapper.selectOneById(RUN_ID)).thenReturn(leased);
        PlatformRunRecoveryCheckpoint checkpoint = new PlatformRunRecoveryCheckpoint();
        checkpoint.setFenceToken(1L);
        checkpoint.setContainerId("existing-container");
        when(recoveryService.requireResumable(APPLICATION_ID, RUN_ID)).thenReturn(checkpoint);
        when(leaseService.grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString()))
            .thenReturn(lease());
        org.mockito.Mockito.doThrow(new BusinessException(ErrorCode.FORBIDDEN_ERROR, "claim lost"))
            .when(recoveryService).claim(RUN_ID, 1L, FENCE_TOKEN, "existing-container", "restart-1");

        assertThrows(BusinessException.class, () -> executionService.grantLease(
            APPLICATION_ID_TEXT, RUN_ID, "RUNTIME_RESTART", "restart-1", 1
        ));
        verify(leaseService).release(RUN_ID, FENCE_TOKEN, PlatformActor.PLATFORM,
            "RUN_RECOVERY_CLAIM_FAILED", "restart-1-compensate-release");
        verify(sandboxExecutor, never()).start(anyString(), anyLong());
    }

    @Test
    void failedStateTransitionCompensatesGrantedLeaseBeforeStartingContainer() {
        when(leaseService.grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString()))
            .thenReturn(lease());
        org.mockito.Mockito.doThrow(new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 状态已变化"))
            .when(runTransitionService).transition(eq(RUN_ID), eq(PlatformRunState.CREATED),
                eq(PlatformRunState.LEASED), any(), anyString(), any(), anyString());

        assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-race")
        );
        verify(leaseService).release(eq(RUN_ID), eq(FENCE_TOKEN), eq(PlatformActor.PLATFORM),
            eq("RUN_TRANSITION_FAILED"), eq("req-race-compensate-release"));
        verify(sandboxExecutor, never()).start(anyString(), anyLong());
    }

    @Test
    void unsupportedBaselineIsRejectedBeforeLeaseGrant() {
        when(baselineCodec.deserialize(BASELINE_JSON)).thenThrow(
            new BusinessException(ErrorCode.PARAMS_ERROR, "TaskExecutionBaseline schema version 不支持")
        );

        assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-1")
        );
        verify(leaseService, never()).grant(anyString(), any(), anyString(), anyString());
        verify(sandboxExecutor, never()).start(anyString(), anyLong());
    }

    @Test
    void sandboxStartFailureReleasesLeaseThenFailsRunAndPreservesRootCause() {
        when(leaseService.grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString()))
            .thenReturn(lease());
        when(sandboxExecutor.start(RUN_ID, APPLICATION_ID)).thenThrow(
            new BusinessException(ErrorCode.OPERATION_ERROR, "镜像缺失")
        );

        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-1")
        );

        // 首个根因必须原样抛出，不被补偿过程覆盖
        assertEquals("镜像缺失", raised.getMessage());
        // LEASED→FAILED 要求已无 Lease 行，所以必须先释放再转终态
        InOrder order = inOrder(leaseService, runTransitionService);
        order.verify(leaseService).release(
            eq(RUN_ID),
            eq(FENCE_TOKEN),
            eq(PlatformActor.PLATFORM),
            eq("SANDBOX_START_FAILED"),
            anyString()
        );
        order.verify(runTransitionService).transition(
            eq(RUN_ID),
            eq(PlatformRunState.LEASED),
            eq(PlatformRunState.FAILED),
            eq(PlatformActor.PLATFORM),
            eq("SANDBOX_START_FAILED"),
            any(),
            anyString()
        );
    }

    @Test
    void compensationFailureDoesNotMaskOriginalStartFailure() {
        when(leaseService.grant(eq(RUN_ID), eq(PlatformActor.RUNTIME), anyString(), anyString()))
            .thenReturn(lease());
        when(sandboxExecutor.start(RUN_ID, APPLICATION_ID)).thenThrow(
            new BusinessException(ErrorCode.OPERATION_ERROR, "镜像缺失")
        );
        org.mockito.Mockito
            .doThrow(new BusinessException(ErrorCode.SYSTEM_ERROR, "释放也失败了"))
            .when(leaseService)
            .release(anyString(), anyLong(), any(), anyString(), anyString());

        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.grantLease(APPLICATION_ID_TEXT, RUN_ID, "RUN_STARTED", "req-1")
        );

        assertEquals("镜像缺失", raised.getMessage());
    }

    /**
     * 计划步骤 29 要求的确定性交错：fence 校验通过后、容器被使用前 Lease 被释放。
     *
     * <p>用「第二次实查抛出」精确模拟这个窗口——容器查询本身可能耗时，一次校验覆盖不了它。
     * 断言命令<strong>没有</strong>落到容器上：这是该防护存在的全部意义。
     */
    @Test
    void leaseReleasedBetweenFenceCheckAndContainerUseRejectsCommand() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString()))
            .thenReturn(lease())
            .thenThrow(new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 未持有 Lease"));
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(handle()));

        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.execute(
                APPLICATION_ID_TEXT,
                RUN_ID,
                FENCE_TOKEN,
                "rm -rf /workspace",
                60,
                "req-interleaved"
            )
        );

        assertEquals(ErrorCode.NOT_FOUND_ERROR.getCode(), raised.getCode());
        verify(sandboxExecutor, never()).exec(any(), anyString(), anyInt(), any(), any());
        verify(runTransitionService, never()).transition(
            anyString(),
            any(),
            any(),
            any(),
            any(),
            any(),
            anyString()
        );
    }

    @Test
    void firstCommandAdvancesRunToExecutingAndLaterCommandsDoNot() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(handle()));
        when(sandboxExecutor.exec(any(), anyString(), anyInt(), any(), any())).thenReturn(0);
        when(runMapper.selectOneByQuery(any()))
            .thenReturn(run(PlatformRunState.LEASED))
            .thenReturn(run(PlatformRunState.EXECUTING));

        PlatformRunCommandResultVO first = executionService.execute(
            APPLICATION_ID_TEXT,
            RUN_ID,
            FENCE_TOKEN,
            "npm run build",
            60,
            "req-1"
        );
        executionService.execute(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "npm test", 60, "req-2");

        assertEquals(0, first.getExitCode());
        verify(runTransitionService).transition(
            eq(RUN_ID),
            eq(PlatformRunState.LEASED),
            eq(PlatformRunState.EXECUTING),
            eq(PlatformActor.PLATFORM),
            anyString(),
            any(),
            anyString()
        );
        verify(runTransitionService, never()).transition(
            eq(RUN_ID),
            eq(PlatformRunState.EXECUTING),
            eq(PlatformRunState.EXECUTING),
            any(),
            anyString(),
            any(),
            anyString()
        );
    }

    @Test
    void missingSandboxContainerIsRejectedBeforeExec() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.empty());

        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.execute(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "ls", 60, "req-1")
        );

        assertEquals(ErrorCode.NOT_FOUND_ERROR.getCode(), raised.getCode());
        verify(sandboxExecutor, never()).exec(any(), anyString(), anyInt(), any(), any());
    }

    @Test
    void commandTimeoutAboveConfiguredCapIsRejected() {
        int overCap = sandboxProperties.getMaxCommandTimeoutSeconds() + 1;

        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.execute(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "sleep 1", overCap, "req-1")
        );

        assertEquals(ErrorCode.PARAMS_ERROR.getCode(), raised.getCode());
        // 无上限超时等于一次请求长期占住容器与 Lease（.agents/rules/errors.md）
        verify(leaseService, never()).requireHeldLease(anyString(), anyLong(), anyString());
    }

    @Test
    void absentTimeoutFallsBackToConfiguredDefault() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(handle()));
        when(sandboxExecutor.exec(any(), anyString(), anyInt(), any(), any())).thenReturn(0);
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.EXECUTING));

        executionService.execute(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "ls", null, "req-1");

        verify(sandboxExecutor).exec(
            any(),
            eq("ls"),
            eq(sandboxProperties.getDefaultCommandTimeoutSeconds()),
            any(),
            any()
        );
    }

    @Test
    void successWithoutSnapshotDoesNotStopSandboxOrReleaseLease() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.EXECUTING));

        assertThrows(BusinessException.class, () -> executionService.reportResult(
            APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "SUCCEEDED", "RUN_FINISHED", null, "req-1"
        ));

        verify(sandboxExecutor, never()).stop(any());
        verify(leaseService, never()).release(anyString(), anyLong(), any(), anyString(), anyString());
        verify(runTransitionService, never()).transition(anyString(), any(), any(), any(), anyString(), any(), anyString());
    }

    @Test
    void reportStopsContainerThenReleasesLeaseThenWritesTerminalState() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(handle()));
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.EXECUTING));
        when(snapshotService.requireReady(APPLICATION_ID, RUN_ID)).thenReturn(new CandidateSourceSnapshot());

        executionService.reportResult(
            APPLICATION_ID_TEXT,
            RUN_ID,
            FENCE_TOKEN,
            "SUCCEEDED",
            "RUN_FINISHED",
            "artifact-1",
            "req-1"
        );

        // 终态转换要求确实已无 Lease 行，因此释放必须在转换之前；
        // 容器停止在释放之前，避免出现「已无写入权但容器还在跑」的窗口
        InOrder order = inOrder(sandboxExecutor, leaseService, runTransitionService);
        order.verify(sandboxExecutor).stop(any());
        order.verify(leaseService).release(
            eq(RUN_ID),
            eq(FENCE_TOKEN),
            eq(PlatformActor.RUNTIME),
            anyString(),
            anyString()
        );
        order.verify(runTransitionService).transition(
            eq(RUN_ID),
            eq(PlatformRunState.EXECUTING),
            eq(PlatformRunState.SUCCEEDED),
            eq(PlatformActor.PLATFORM),
            anyString(),
            eq("artifact-1"),
            anyString()
        );
    }

    /**
     * 期望状态实读而非写死 EXECUTING：一次命令都没执行就失败的 Run 仍是 LEASED，
     * 写死会让这条真实路径无法上报。
     */
    @Test
    void runThatNeverExecutedAnyCommandCanStillReportFailure() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.empty());
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.LEASED));

        executionService.reportResult(
            APPLICATION_ID_TEXT,
            RUN_ID,
            FENCE_TOKEN,
            "FAILED",
            "ENGINE_UNAVAILABLE",
            null,
            "req-1"
        );

        verify(runTransitionService).transition(
            eq(RUN_ID),
            eq(PlatformRunState.LEASED),
            eq(PlatformRunState.FAILED),
            eq(PlatformActor.PLATFORM),
            anyString(),
            any(),
            anyString()
        );
    }

    @Test
    void nonTerminalOutcomeIsRejectedBeforeAnyLeaseWork() {
        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.reportResult(
                APPLICATION_ID_TEXT,
                RUN_ID,
                FENCE_TOKEN,
                "EXECUTING",
                "RUN_ALIVE",
                null,
                "req-1"
            )
        );

        assertEquals(ErrorCode.PARAMS_ERROR.getCode(), raised.getCode());
        verify(leaseService, never()).requireHeldLease(anyString(), anyLong(), anyString());
        verify(leaseService, never()).release(anyString(), anyLong(), any(), anyString(), anyString());
    }

    @Test
    void releaseStopsContainerBeforeGivingUpWriteRight() {
        when(leaseService.requireHeldLease(eq(RUN_ID), eq(FENCE_TOKEN), anyString())).thenReturn(lease());
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(handle()));

        executionService.releaseLease(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "RUN_FINISHED", "req-1");

        InOrder order = inOrder(sandboxExecutor, leaseService);
        order.verify(sandboxExecutor).stop(any());
        order.verify(leaseService).release(
            eq(RUN_ID),
            eq(FENCE_TOKEN),
            eq(PlatformActor.RUNTIME),
            anyString(),
            anyString()
        );
    }

    @Test
    void runNotOwnedByDeclaredApplicationIsRejectedBeforeLeaseWork() {
        org.mockito.Mockito
            .doThrow(new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 不属于该 Application"))
            .when(relationValidator)
            .requireRunBelongsToApplication(APPLICATION_ID, RUN_ID);

        assertThrows(
            BusinessException.class,
            () -> executionService.execute(APPLICATION_ID_TEXT, RUN_ID, FENCE_TOKEN, "ls", 60, "req-1")
        );

        // 鉴权延后期间这是唯一的跨 Application 拦截点，必须在任何 Lease 工作之前生效
        verify(leaseService, never()).requireHeldLease(anyString(), anyLong(), anyString());
        verify(sandboxExecutor, never()).find(anyString());
    }

    @Test
    void malformedApplicationIdIsRejectedWithoutTouchingCollaborators() {
        BusinessException raised = assertThrows(
            BusinessException.class,
            () -> executionService.execute("not-a-number", RUN_ID, FENCE_TOKEN, "ls", 60, "req-1")
        );

        assertEquals(ErrorCode.PARAMS_ERROR.getCode(), raised.getCode());
        verify(relationValidator, never()).requireActiveApplication(anyLong());
        verify(leaseService, never()).requireHeldLease(anyString(), anyLong(), anyString());
    }

    @Test
    void capabilitiesReportRealConfiguredLimitsAndLeaseConstants() {
        var capabilities = executionService.buildCapabilities();

        assertEquals("1", capabilities.getSchemaVersion());
        assertEquals(sandboxProperties.getMemoryLimitMb(), capabilities.getMemoryLimitMb());
        assertEquals(sandboxProperties.getCpuLimit(), capabilities.getCpuLimit());
        assertEquals(sandboxProperties.getPidsLimit(), capabilities.getPidsLimit());
        assertEquals(PlatformRunLeaseService.LEASE_TTL_SECONDS, capabilities.getLeaseTtlSeconds());
        assertEquals(
            PlatformRunLeaseService.LEASE_MAX_RENEW_COUNT,
            capabilities.getLeaseMaxRenewCount()
        );
        // AD-016 的隔离事实不可由 Runtime 推断，必须由这里如实下发
        assertEquals(false, capabilities.isNetworkAccessAvailable());
        assertEquals(false, capabilities.isWorkspacePersistent());
        assertEquals(true, capabilities.isReadonlyRootFilesystem());
    }

    private PlatformRunLease lease() {
        PlatformRunLease lease = new PlatformRunLease();
        lease.setRunId(RUN_ID);
        lease.setApplicationId(APPLICATION_ID);
        lease.setTaskId(TASK_ID);
        lease.setFenceToken(FENCE_TOKEN);
        lease.setGrantedAt(LocalDateTime.now());
        lease.setExpiresAt(LocalDateTime.now().plusSeconds(PlatformRunLeaseService.LEASE_TTL_SECONDS));
        lease.setRenewCount(0);
        return lease;
    }

    private PlatformRun run(PlatformRunState state) {
        PlatformRun run = new PlatformRun();
        run.setId(RUN_ID);
        run.setApplicationId(APPLICATION_ID);
        run.setTaskId(TASK_ID);
        run.setState(state.name());
        run.setAttemptNumber(1);
        return run;
    }

    private PlatformSandboxHandle handle() {
        return new PlatformSandboxHandle("container-1", RUN_ID, APPLICATION_ID);
    }
}
