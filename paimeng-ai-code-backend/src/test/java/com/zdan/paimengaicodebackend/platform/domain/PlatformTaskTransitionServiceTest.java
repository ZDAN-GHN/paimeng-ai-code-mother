package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.junit.jupiter.api.Test;

class PlatformTaskTransitionServiceTest {

    private final PlatformTaskMapper taskMapper = mock(PlatformTaskMapper.class);
    private final PlatformTaskTransitionService transitionService = new PlatformTaskTransitionService(
        new PlatformTaskStateMachine(),
        taskMapper
    );

    @Test
    void persistsAllowedTransitionWithExpectedStateCondition() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(1);

        transitionService.transition(
            task,
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false)
        );

        assertEquals(PlatformTaskState.READY.name(), task.getState());
    }

    @Test
    void rejectsTransitionWhenConcurrentWriterChangedTheState() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        when(taskMapper.updateByQuery(any(PlatformTask.class), eq(true), any())).thenReturn(0);

        assertThrows(BusinessException.class, () -> transitionService.transition(
            task,
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false)
        ));
        assertEquals(PlatformTaskState.CREATED.name(), task.getState());
    }

    @Test
    void rejectsUnexpectedPersistedTaskState() {
        PlatformTask task = task(PlatformTaskState.CREATED);
        task.setState("unknown");

        assertThrows(BusinessException.class, () -> transitionService.transition(
            task,
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false)
        ));
    }

    private PlatformTask task(PlatformTaskState state) {
        PlatformTask task = new PlatformTask();
        task.setId(1L);
        task.setState(state.name());
        return task;
    }
}
