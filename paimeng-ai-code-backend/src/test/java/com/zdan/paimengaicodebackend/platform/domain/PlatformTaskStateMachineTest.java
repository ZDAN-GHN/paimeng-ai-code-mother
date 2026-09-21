package com.zdan.paimengaicodebackend.platform.domain;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import org.junit.jupiter.api.Test;

class PlatformTaskStateMachineTest {

    private final PlatformTaskStateMachine stateMachine = new PlatformTaskStateMachine();

    @Test
    void createdTaskRequiresFrozenBaselineBeforeReady() {
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none()
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.CREATED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false)
        ));
    }

    @Test
    void blockedTaskCanReNormalizeOnlyBeforeBaselineFreezes() {
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.BLOCKED,
            PlatformTaskState.CREATED,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none()
        ));
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.BLOCKED,
            PlatformTaskState.CREATED,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, false)
        ));
    }

    @Test
    void executingTaskCannotBlockOrCancelUntilRunStopsAndLeaseReleases() {
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.EXECUTING,
            PlatformTaskState.BLOCKED,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none()
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.EXECUTING,
            PlatformTaskState.BLOCKED,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, true, false, false, false)
        ));
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.EXECUTING,
            PlatformTaskState.CANCELLED,
            PlatformActor.OWNER,
            TaskTransitionConditions.none()
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.EXECUTING,
            PlatformTaskState.CANCELLED,
            PlatformActor.OWNER,
            new TaskTransitionConditions(true, true, false, false, false)
        ));
    }

    @Test
    void failedTaskRequiresOwnerRequestedRetry() {
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.FAILED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none()
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.FAILED,
            PlatformTaskState.READY,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, true, false, false)
        ));
    }

    @Test
    void validatedTaskRequiresFirstReleaseOrOwnerConfirmation() {
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.VALIDATED,
            PlatformTaskState.RELEASED,
            PlatformActor.PLATFORM,
            TaskTransitionConditions.none()
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.VALIDATED,
            PlatformTaskState.RELEASED,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, true, false)
        ));
        assertDoesNotThrow(() -> transition(
            PlatformTaskState.VALIDATED,
            PlatformTaskState.RELEASED,
            PlatformActor.PLATFORM,
            new TaskTransitionConditions(true, false, false, false, true)
        ));
    }

    @Test
    void agentCannotActAsPlatformStateAuthority() {
        assertThrows(BusinessException.class, () -> transition(
            PlatformTaskState.EXECUTING,
            PlatformTaskState.VALIDATED,
            PlatformActor.AGENT,
            new TaskTransitionConditions(true, false, false, false, false)
        ));
    }

    @Test
    void runStateMachineCoversLeaseRejectionAndTerminalRejection() {
        assertDoesNotThrow(() -> stateMachine.assertRunTransition(
            PlatformRunState.CREATED,
            PlatformRunState.FAILED,
            PlatformActor.PLATFORM
        ));
        assertDoesNotThrow(() -> stateMachine.assertRunTransition(
            PlatformRunState.LEASED,
            PlatformRunState.EXECUTING,
            PlatformActor.PLATFORM
        ));
        assertDoesNotThrow(() -> stateMachine.assertRunTransition(
            PlatformRunState.EXECUTING,
            PlatformRunState.SUCCEEDED,
            PlatformActor.PLATFORM
        ));
        assertThrows(BusinessException.class, () -> stateMachine.assertRunTransition(
            PlatformRunState.SUCCEEDED,
            PlatformRunState.EXECUTING,
            PlatformActor.PLATFORM
        ));
    }

    private void transition(
        PlatformTaskState from,
        PlatformTaskState target,
        PlatformActor requestedBy,
        TaskTransitionConditions conditions
    ) {
        stateMachine.assertTaskTransition(from, target, requestedBy, conditions);
    }
}
