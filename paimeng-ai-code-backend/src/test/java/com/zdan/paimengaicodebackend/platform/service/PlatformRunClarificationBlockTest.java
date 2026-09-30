package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunLeaseService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRunTransitionService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.domain.TaskExecutionBaselineCodec;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxExecutor;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxHandle;
import com.zdan.paimengaicodebackend.platform.sandbox.PlatformSandboxProperties;
import com.zdan.paimengaicodebackend.platform.snapshot.CandidateSnapshotService;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.mockito.Mockito;

/**
 * 受控执行中的业务歧义阻断（Issue #80 / T-08）
 *
 * <p>这里断言的不是「能不能阻断」，而是阻断的<strong>顺序</strong>：先停 Sandbox、再释放
 * Lease、再让 Run 进终态、最后才把 Task 落到 {@code blocked}。反过来会出现「已阻断但仍可写入」
 * 的窗口，而 D-06 的 {@code executing -> blocked} 前置条件正是「Run 已停止且不再持有 Lease」。
 */
class PlatformRunClarificationBlockTest {

    private static final String APPLICATION_ID = "460017668615995392";
    private static final String RUN_ID = "run-7001";
    private static final Long FENCE_TOKEN = 3L;
    private static final Long TASK_ID = 460017668615995394L;

    private final PlatformRunLeaseService leaseService = mock(PlatformRunLeaseService.class);
    private final PlatformRunTransitionService runTransitionService = mock(PlatformRunTransitionService.class);
    private final PlatformLogicalRelationValidator relationValidator = mock(PlatformLogicalRelationValidator.class);
    private final PlatformSandboxExecutor sandboxExecutor = mock(PlatformSandboxExecutor.class);
    private final PlatformRunMapper runMapper = mock(PlatformRunMapper.class);
    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final CandidateSnapshotService snapshotService = mock(CandidateSnapshotService.class);
    private final PlatformTaskLifecycleService taskLifecycle = mock(PlatformTaskLifecycleService.class);

    private PlatformRunExecutionService executionService;

    @BeforeEach
    void setUp() {
        executionService = new PlatformRunExecutionService(leaseService, runTransitionService, relationValidator,
            sandboxExecutor, new PlatformSandboxProperties(), runMapper, taskMapper,
            mock(TaskExecutionBaselineCodec.class), mock(PlatformRunRecoveryService.class), snapshotService,
            taskLifecycle);
        when(sandboxExecutor.find(RUN_ID)).thenReturn(Optional.of(mock(PlatformSandboxHandle.class)));
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.EXECUTING));
    }

    @Test
    void blockingStopsSandboxAndReleasesLeaseBeforeTheTaskIsBlocked() {
        executionService.blockForClarification(
            APPLICATION_ID, RUN_ID, FENCE_TOKEN, "生成的页面需要支持哪些角色？", "req-1");

        InOrder order = Mockito.inOrder(sandboxExecutor, leaseService, runTransitionService, taskLifecycle);
        order.verify(sandboxExecutor).stop(any(PlatformSandboxHandle.class));
        order.verify(leaseService).release(eq(RUN_ID), eq(FENCE_TOKEN), eq(PlatformActor.RUNTIME),
            eq("BUSINESS_CLARIFICATION_REQUIRED"), eq("req-1"));
        order.verify(runTransitionService).transition(eq(RUN_ID), eq(PlatformRunState.EXECUTING),
            eq(PlatformRunState.CANCELLED), eq(PlatformActor.PLATFORM),
            eq("BUSINESS_CLARIFICATION_REQUIRED"), eq(null), eq("req-1-run-cancelled"));
        order.verify(taskLifecycle).markBlockedAfterRunStopped(eq(TASK_ID),
            eq("生成的页面需要支持哪些角色？"), eq("BUSINESS_CLARIFICATION_REQUIRED"), eq("req-1-task-blocked"));
    }

    @Test
    void anUnusableQuestionIsRejectedBeforeAnythingIsTornDown() {
        assertEquals(40000, assertThrows(BusinessException.class, () -> executionService.blockForClarification(
            APPLICATION_ID, RUN_ID, FENCE_TOKEN, "   ", "req-1")).getCode());
        assertEquals(40000, assertThrows(BusinessException.class, () -> executionService.blockForClarification(
            APPLICATION_ID, RUN_ID, FENCE_TOKEN, "x".repeat(501), "req-1")).getCode());

        // 一次受控执行不能因为一个问题不合格就被拆掉。
        verify(sandboxExecutor, never()).stop(any());
        verify(leaseService, never()).release(anyString(), anyLong(), any(), anyString(), anyString());
        verify(taskLifecycle, never()).markBlockedAfterRunStopped(anyLong(), anyString(), anyString(), anyString());
    }

    @Test
    void aRunThatAlreadyReachedATerminalStateCannotBeBlockedAgain() {
        when(runMapper.selectOneByQuery(any())).thenReturn(run(PlatformRunState.SUCCEEDED));

        assertEquals(40300, assertThrows(BusinessException.class, () -> executionService.blockForClarification(
            APPLICATION_ID, RUN_ID, FENCE_TOKEN, "问题？", "req-1")).getCode());

        verify(taskLifecycle, never()).markBlockedAfterRunStopped(anyLong(), anyString(), anyString(), anyString());
    }

    @Test
    void blockingRequiresAHeldLease() {
        org.mockito.Mockito.doThrow(new BusinessException(
                com.zdan.paimengaicodebackend.exception.ErrorCode.FORBIDDEN_ERROR, "Lease 已失效"))
            .when(leaseService).requireHeldLease(RUN_ID, FENCE_TOKEN, "req-1");

        assertThrows(BusinessException.class, () -> executionService.blockForClarification(
            APPLICATION_ID, RUN_ID, FENCE_TOKEN, "问题？", "req-1"));

        verify(sandboxExecutor, never()).stop(any());
        verify(taskLifecycle, never()).markBlockedAfterRunStopped(anyLong(), anyString(), anyString(), anyString());
    }

    private PlatformRun run(PlatformRunState state) {
        PlatformRun run = new PlatformRun();
        run.setId(RUN_ID);
        run.setApplicationId(460017668615995392L);
        run.setTaskId(TASK_ID);
        run.setState(state.name());
        return run;
    }
}
