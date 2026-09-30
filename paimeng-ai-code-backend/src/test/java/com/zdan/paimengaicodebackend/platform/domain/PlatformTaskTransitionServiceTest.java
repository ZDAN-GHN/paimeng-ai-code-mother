package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskTransitionEventMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.junit.jupiter.api.Test;

class PlatformTaskTransitionServiceTest {

    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final PlatformTaskTransitionEventMapper eventMapper = mock(
        PlatformTaskTransitionEventMapper.class
    );
    private final PlatformLogicalRelationValidator relationValidator = mock(
        PlatformLogicalRelationValidator.class
    );
    private final PlatformRunLeaseService leaseService = mock(PlatformRunLeaseService.class);
    private final PlatformRunMapper runMapper = mock(PlatformRunMapper.class);
    private final PlatformTaskRetryRequestMapper retryRequestMapper =
        mock(PlatformTaskRetryRequestMapper.class);
    private final PlatformTaskTransitionService transitionService = new PlatformTaskTransitionService(
        new PlatformTaskStateMachine(),
        taskMapper,
        eventMapper,
        relationValidator,
        leaseService,
        runMapper,
        retryRequestMapper
    );

    @Test
    void persistsAllowedTransitionAndAppendsAuditEvent() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        task.setBaselineJson("{}");
        when(taskMapper.selectOneByQuery(any())).thenReturn(task);
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(1);

        transitionService.transition(
            task.getId(),
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "BASELINE_FROZEN",
            null,
            "task-transition-1"
        );

        verify(eventMapper).insert(any());
    }

    @Test
    void rejectsTransitionWhenConcurrentWriterChangedTheState() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        task.setBaselineJson("{}");
        when(taskMapper.selectOneByQuery(any())).thenReturn(task);
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(0);

        assertThrows(BusinessException.class, () -> transitionService.transition(
            task.getId(),
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "BASELINE_FROZEN",
            null,
            "task-transition-2"
        ));
    }

    @Test
    void rejectsUnexpectedPersistedTaskState() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        task.setState("unknown");
        when(taskMapper.selectOneByQuery(any())).thenReturn(task);

        assertThrows(BusinessException.class, () -> transitionService.transition(
            task.getId(),
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none(),
            "BASELINE_FROZEN",
            null,
            "task-transition-3"
        ));
    }

    @Test
    void rejectsValidatedTransitionWithoutEvidenceReference() {
        PlatformTask task = task(PlatformTaskState.EXECUTING);
        task.setBaselineJson("{}");
        when(taskMapper.selectOneByQuery(any())).thenReturn(task);

        assertThrows(BusinessException.class, () -> transitionService.transition(
            task.getId(),
            PlatformTaskState.EXECUTING,
            PlatformTaskState.VALIDATED,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false, true, true),
            "VALIDATION_PASSED",
            null,
            "task-transition-4"
        ));
    }

    private PlatformTask task(PlatformTaskState state) {
        PlatformTask task = new PlatformTask();
        task.setId(1L);
        task.setApplicationId(2L);
        task.setRequirementId(3L);
        task.setState(state.name());
        return task;
    }

    /**
     * `failed -> ready` 的前置是「Owner 显式请求重试」，而这条事实由 Platform 实查。
     *
     * <p>用例要钉住的是：调用方把 {@code retryRequestedByOwner} 自报成 true 也没用——
     * 表里没有行，转换就必须被拒绝。否则任何内部调用方都能凭一个布尔伪造 Owner 决策。
     */
    @Test
    void failedToReadyIsRejectedWhenNoOwnerRetryWasEverAccepted() {
        when(retryRequestMapper.countAcceptedForTask(1L)).thenReturn(0);
        PlatformTask failed = failedTaskWithBaseline();
        when(taskMapper.selectOneByQuery(any())).thenReturn(failed);

        BusinessException rejection = assertThrows(
            BusinessException.class,
            () -> transitionService.transition(
                1L, PlatformTaskState.FAILED, PlatformTaskState.READY, PlatformActor.PLATFORM,
                TaskTransitionConditions.none(), "OWNER_RETRY_REQUESTED", null, "retry-1"
            )
        );

        assertEquals(40300, rejection.getCode());
        assertEquals("FAILED", failed.getState());
        verify(taskMapper, never()).updateByQuery(any(PlatformTask.class), eq(true), any());
        verify(eventMapper, never()).insertSelective(any());
    }

    /** 事实成立时才放行：表里有行，说明 Platform 已受理过一次 Owner 重试。 */
    @Test
    void failedToReadyProceedsOnceAnOwnerRetryRequestExists() {
        when(retryRequestMapper.countAcceptedForTask(1L)).thenReturn(1);
        PlatformTask failed = failedTaskWithBaseline();
        when(taskMapper.selectOneByQuery(any())).thenReturn(failed);
        when(taskMapper.updateByQuery(any(), eq(true), any())).thenReturn(1);

        transitionService.transition(
            1L, PlatformTaskState.FAILED, PlatformTaskState.READY, PlatformActor.PLATFORM,
            TaskTransitionConditions.none(), "OWNER_RETRY_REQUESTED", "701", "retry-1"
        );

        assertEquals("FAILED", failed.getState(), "转换通过 updateByQuery 落库，不改内存对象");
        verify(taskMapper).updateByQuery(any(PlatformTask.class), eq(true), any());
        verify(eventMapper).insert(any());
    }

    private PlatformTask failedTaskWithBaseline() {
        PlatformTask task = new PlatformTask();
        task.setId(1L);
        task.setApplicationId(2L);
        task.setState(PlatformTaskState.FAILED.name());
        task.setBaselineJson("{\"schemaVersion\":1}");
        return task;
    }
}
