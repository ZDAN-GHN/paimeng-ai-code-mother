package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskRetryRequestMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTaskRetryRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Owner 显式重试（Issue #80 / Slice 2）
 *
 * <p>核心断言是「前置条件从自报变成事实」：此前 {@code failed -> ready} 只看调用方传的
 * {@code retryRequestedByOwner} 布尔，任何内部调用方都能伪造一次 Owner 请求。
 */
class PlatformTaskRetryServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long TASK_ID = 460017668615995394L;
    private static final String BASELINE_JSON = "{\"schemaVersion\":1}";

    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final PlatformRunMapper runMapper = mock(PlatformRunMapper.class);
    private final PlatformTaskRetryRequestMapper retryMapper = mock(PlatformTaskRetryRequestMapper.class);
    private final PlatformLogicalRelationValidator relationValidator = mock(PlatformLogicalRelationValidator.class);
    private final PlatformTaskTransitionService transitions = mock(PlatformTaskTransitionService.class);

    private PlatformTaskRetryService retryService;

    @BeforeEach
    void setUp() {
        retryService = new PlatformTaskRetryService(
            taskMapper, runMapper, retryMapper, relationValidator, transitions);
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(task(PlatformTaskState.FAILED));
        when(retryMapper.countAcceptedForTask(TASK_ID)).thenReturn(0);
        when(runMapper.selectLatestForTask(TASK_ID)).thenReturn(previousRun(1));
        when(runMapper.insertSelective(any(PlatformRun.class))).thenReturn(1);
    }

    @Test
    void retryRecordsTheOwnerFactBeforeTransitioningAndCreatesANewRun() {
        doAnswerAssigningId();

        var outcome = retryService.requestRetry(
            APPLICATION_ID, TASK_ID, PlatformActor.OWNER, "重跑一次", "retry-1");

        // 顺序是契约的一部分：状态机自己实查这张表决定 retryRequestedByOwner 是否成立，
        // 事实必须先于转换落库。
        var request = ArgumentCaptor.forClass(PlatformTaskRetryRequest.class);
        verify(retryMapper).insertSelective(request.capture());
        assertEquals("OWNER", request.getValue().getActorType());
        assertEquals("重跑一次", request.getValue().getReason());
        assertEquals("retry-1", request.getValue().getRequestId());

        // Owner 的身份体现在重试行里，转换本身必须由 Platform 裁决。
        verify(transitions).transition(eq(TASK_ID), eq(PlatformTaskState.FAILED), eq(PlatformTaskState.READY),
            eq(PlatformActor.PLATFORM), any(), eq("OWNER_RETRY_REQUESTED"), any(), eq("retry-1-transition"));

        assertEquals(TASK_ID, outcome.taskId());
        // 重试递增尝试号：上一台 Run 的终态是证据，不能覆盖。
        assertEquals(2, outcome.attemptNumber());
        assertTrue(outcome.runId().startsWith("run-"));
    }

    @Test
    void aRunIsNeverResumedInPlace() {
        doAnswerAssigningId();

        var outcome = retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.OWNER, null, "retry-1");

        ArgumentCaptor<PlatformRun> created = ArgumentCaptor.forClass(PlatformRun.class);
        verify(runMapper).insertSelective(created.capture());
        assertEquals("CREATED", created.getValue().getState());
        assertEquals(2, created.getValue().getAttemptNumber());
        assertEquals(outcome.runId(), created.getValue().getId());
    }

    @Test
    void aNonOwnerCannotRequestRetry() {
        BusinessException rejection = assertThrows(BusinessException.class,
            () -> retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.RUNTIME, null, "retry-1"));

        assertEquals(40101, rejection.getCode());
        verify(retryMapper, never()).insertSelective(any());
        verify(transitions, never()).transition(any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void onlyAFailedTaskWithAFrozenBaselineIsRetryable() {
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(task(PlatformTaskState.VALIDATED));
        assertEquals(40300, assertThrows(BusinessException.class,
            () -> retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.OWNER, null, "retry-1")).getCode());

        PlatformTask baselineLess = task(PlatformTaskState.FAILED);
        baselineLess.setBaselineJson(null);
        when(taskMapper.selectOneById(TASK_ID)).thenReturn(baselineLess);
        assertEquals(40300, assertThrows(BusinessException.class,
            () -> retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.OWNER, null, "retry-1")).getCode());
    }

    @Test
    void theSameFailedTaskCannotBeRetriedTwice() {
        when(retryMapper.countAcceptedForTask(TASK_ID)).thenReturn(1);

        assertEquals(40300, assertThrows(BusinessException.class,
            () -> retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.OWNER, null, "retry-2")).getCode());
        verify(runMapper, never()).insertSelective(any());
    }

    @Test
    void anOverlongIdempotencyKeyIsRejectedBeforeAnythingIsWritten() {
        // 键后面还要拼 "-transition"，列宽 64；不限制就会在落库时炸成一个不可解释的截断错误。
        assertEquals(40000, assertThrows(BusinessException.class,
            () -> retryService.requestRetry(
                APPLICATION_ID, TASK_ID, PlatformActor.OWNER, null, "r".repeat(41))).getCode());
        verify(retryMapper, never()).insertSelective(any());
    }

    @Test
    void reasonIsAuditOnlyAndNormalisedToASingleLine() {
        doAnswerAssigningId();

        retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.OWNER, "  第一行\n第二行  ", "retry-1");

        var request = ArgumentCaptor.forClass(PlatformTaskRetryRequest.class);
        verify(retryMapper).insertSelective(request.capture());
        assertEquals("第一行 第二行", request.getValue().getReason());
    }

    @Test
    void anAbsentReasonStaysNullRatherThanBecomingAnEmptyString() {
        doAnswerAssigningId();

        retryService.requestRetry(APPLICATION_ID, TASK_ID, PlatformActor.SYSTEM_ADMINISTRATOR, "   ", "retry-1");

        var request = ArgumentCaptor.forClass(PlatformTaskRetryRequest.class);
        verify(retryMapper).insertSelective(request.capture());
        assertNull(request.getValue().getReason());
    }

    private void doAnswerAssigningId() {
        org.mockito.Mockito.doAnswer(invocation -> {
            invocation.getArgument(0, PlatformTaskRetryRequest.class).setId(701L);
            return 1;
        }).when(retryMapper).insertSelective(any());
    }

    private PlatformTask task(PlatformTaskState state) {
        PlatformTask task = new PlatformTask();
        task.setId(TASK_ID);
        task.setApplicationId(APPLICATION_ID);
        task.setState(state.name());
        task.setBaselineJson(BASELINE_JSON);
        return task;
    }

    private PlatformRun previousRun(int attemptNumber) {
        PlatformRun run = new PlatformRun();
        run.setId("run-previous");
        run.setApplicationId(APPLICATION_ID);
        run.setTaskId(TASK_ID);
        run.setState(PlatformRunState.FAILED.name());
        run.setAttemptNumber(attemptNumber);
        return run;
    }
}