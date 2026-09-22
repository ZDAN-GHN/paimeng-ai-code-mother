package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
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
    private final PlatformTaskTransitionService transitionService = new PlatformTaskTransitionService(
        new PlatformTaskStateMachine(),
        taskMapper,
        eventMapper,
        relationValidator
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
}
