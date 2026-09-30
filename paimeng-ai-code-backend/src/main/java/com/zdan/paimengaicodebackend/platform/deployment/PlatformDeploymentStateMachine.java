package com.zdan.paimengaicodebackend.platform.deployment;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import org.springframework.stereotype.Component;

/**
 * 部署状态机（Issue #81 / T-09）
 *
 * <p>与 Task/Run 状态机同一条边界：只有 Platform 受控执行器能推进部署状态，Agent、Owner
 * 与任何外部调用方都不能声明部署处于某个状态。终态（{@code HEALTHY} / {@code UNHEALTHY}）
 * 不可再变，避免「当前是否已上线」成为一个随时可被覆盖的读。
 */
@Component
public class PlatformDeploymentStateMachine {

    public void assertTransition(
        PlatformDeploymentState from,
        PlatformDeploymentState target,
        PlatformActor requestedBy
    ) {
        if (from == target) {
            throw rejected("部署状态未变化");
        }
        if (requestedBy != PlatformActor.PLATFORM) {
            throw rejected("只有 Platform 可以裁决 Deployment 状态");
        }
        boolean allowed = switch (from) {
            case PENDING -> target == PlatformDeploymentState.PROVISIONING;
            case PROVISIONING -> target == PlatformDeploymentState.HEALTHY
                || target == PlatformDeploymentState.UNHEALTHY
                || target == PlatformDeploymentState.PENDING;
            case HEALTHY, UNHEALTHY -> false;
        };
        if (!allowed) {
            throw rejected("不允许的 Deployment 状态转换: " + from + " -> " + target);
        }
    }

    private BusinessException rejected(String message) {
        return new BusinessException(ErrorCode.FORBIDDEN_ERROR, message);
    }
}