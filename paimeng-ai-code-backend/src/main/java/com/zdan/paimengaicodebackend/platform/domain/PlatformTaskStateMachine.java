package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import java.util.Set;
import org.springframework.stereotype.Component;

@Component
public class PlatformTaskStateMachine {

    private static final Set<PlatformTaskState> CANCELLABLE_STATES = Set.of(
        PlatformTaskState.CREATED,
        PlatformTaskState.READY,
        PlatformTaskState.BLOCKED,
        PlatformTaskState.EXECUTING
    );

    public void assertTaskTransition(
        PlatformTaskState from,
        PlatformTaskState target,
        PlatformActor requestedBy,
        TaskTransitionConditions conditions
    ) {
        if (from == target) {
            throw rejected("状态未变化");
        }
        if (target == PlatformTaskState.CANCELLED) {
            if (!CANCELLABLE_STATES.contains(from)) {
                throw rejected("稳定 Task 不能取消");
            }
            if (requestedBy != PlatformActor.OWNER && requestedBy != PlatformActor.SYSTEM_ADMINISTRATOR) {
                throw rejected("只有 Owner 或 System Administrator 可以取消 Task");
            }
            if (from == PlatformTaskState.EXECUTING && !conditions.runStoppedAndLeaseReleased()) {
                throw rejected("运行未停止或 Lease 未释放");
            }
            return;
        }
        if (requestedBy != PlatformActor.PLATFORM) {
            throw rejected("只有 Platform 可以裁决 Task 状态");
        }
        boolean allowed = switch (from) {
            case CREATED ->
                (target == PlatformTaskState.READY && conditions.baselineFrozen()) ||
                target == PlatformTaskState.BLOCKED;
            case BLOCKED -> target == PlatformTaskState.CREATED && !conditions.baselineFrozen();
            case READY ->
                target == PlatformTaskState.EXECUTING && conditions.runCreatedAndLeaseGranted();
            case EXECUTING ->
                (target == PlatformTaskState.BLOCKED && conditions.runStoppedAndLeaseReleased()) ||
                target == PlatformTaskState.FAILED ||
                (target == PlatformTaskState.VALIDATED && conditions.validationPassed());
            case FAILED -> target == PlatformTaskState.READY && conditions.retryRequestedByOwner();
            case VALIDATED ->
                target == PlatformTaskState.RELEASED &&
                (conditions.firstRelease() || conditions.ownerConfirmedPublish());
            case RELEASED, CANCELLED -> false;
        };
        if (!allowed) {
            throw rejected("不允许的 Task 状态转换: " + from + " -> " + target);
        }
    }

    public void assertRunTransition(
        PlatformRunState from,
        PlatformRunState target,
        PlatformActor requestedBy
    ) {
        if (requestedBy != PlatformActor.PLATFORM) {
            throw rejected("只有 Platform 可以裁决 Run 状态");
        }
        boolean allowed = switch (from) {
            case CREATED -> target == PlatformRunState.LEASED || target == PlatformRunState.FAILED;
            case LEASED ->
                target == PlatformRunState.EXECUTING ||
                target == PlatformRunState.FAILED ||
                target == PlatformRunState.CANCELLED;
            case EXECUTING ->
                target == PlatformRunState.SUCCEEDED ||
                target == PlatformRunState.FAILED ||
                target == PlatformRunState.CANCELLED;
            case SUCCEEDED, FAILED, CANCELLED -> false;
        };
        if (!allowed) {
            throw rejected("不允许的 Run 状态转换: " + from + " -> " + target);
        }
    }

    private BusinessException rejected(String message) {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, message);
    }
}
