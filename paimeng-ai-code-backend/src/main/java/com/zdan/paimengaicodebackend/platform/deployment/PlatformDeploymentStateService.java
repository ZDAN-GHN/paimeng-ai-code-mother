package com.zdan.paimengaicodebackend.platform.deployment;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProductionAccessGuard;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Deployment 的数据库裁决（Issue #81 / T-09）
 *
 * <p>与执行动作刻意分开：Docker 调用不参与事务，只有「领取」和「判定终态」需要与状态机在
 * 同一个事务里读到一致的前置状态。
 */
@Service
public class PlatformDeploymentStateService {

    private final PlatformDeploymentMapper deployments;
    private final PlatformDeploymentStateMachine stateMachine;
    private final PlatformProductionAccessGuard productionGuard;

    public PlatformDeploymentStateService(
        PlatformDeploymentMapper deployments,
        PlatformDeploymentStateMachine stateMachine,
        PlatformProductionAccessGuard productionGuard
    ) {
        this.deployments = deployments;
        this.stateMachine = stateMachine;
        this.productionGuard = productionGuard;
    }

    /**
     * 领取一条待执行的部署。
     *
     * @return 空值表示队列为空；这不是失败，只表示暂时没有新固定版本要上线
     */
    @Transactional(rollbackFor = Exception.class)
    public Optional<PlatformDeployment> claimNext() {
        Long id = deployments.selectClaimableId();
        if (id == null) {
            return Optional.empty();
        }
        if (deployments.claim(id) != 1) {
            // 另一个 Platform 实例在同一行上先赢了 SKIP LOCKED 之外的竞争。
            return Optional.empty();
        }
        PlatformDeployment claimed = deployments.selectOneById(id);
        if (claimed == null) {
            throw new BusinessException(ErrorCode.OPERATION_ERROR, "部署领取后不可读取");
        }
        return Optional.of(claimed);
    }

    @Transactional(rollbackFor = Exception.class)
    public void markHealthy(Long deploymentId, String containerId, String containerAddress) {
        PlatformDeployment current = requireState(deploymentId, PlatformDeploymentState.PROVISIONING);
        productionGuard.requirePlatformActor(PlatformActor.PLATFORM);
        stateMachine.assertTransition(
            PlatformDeploymentState.valueOf(current.getState()),
            PlatformDeploymentState.HEALTHY,
            PlatformActor.PLATFORM);
        if (deployments.markHealthy(deploymentId, containerId, containerAddress) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "部署状态已变化，无法标记为已上线");
        }
    }

    @Transactional(rollbackFor = Exception.class)
    public void markUnhealthy(
        Long deploymentId,
        PlatformDeploymentStage stage,
        PlatformDeploymentReasonCode reasonCode,
        String containerId,
        String containerAddress
    ) {
        if (stage == null || reasonCode == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "未健康判定缺少受控诊断值");
        }
        PlatformDeployment current = requireState(deploymentId, PlatformDeploymentState.PROVISIONING);
        productionGuard.requirePlatformActor(PlatformActor.PLATFORM);
        stateMachine.assertTransition(
            PlatformDeploymentState.valueOf(current.getState()),
            PlatformDeploymentState.UNHEALTHY,
            PlatformActor.PLATFORM);
        if (deployments.markUnhealthy(deploymentId, stage.name(), reasonCode.name(),
                containerId, containerAddress) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "部署状态已变化，无法标记为未上线");
        }
    }

    /** 把僵死的 PROVISIONING 放回队列；Platform 被终止后这是唯一让首次部署有机会完成的路径。 */
    @Transactional(rollbackFor = Exception.class)
    public int reclaimStale(int staleSeconds) {
        if (staleSeconds <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "僵死回收阈值不合法");
        }
        return deployments.reclaimStale(
            java.time.LocalDateTime.now().minusSeconds(staleSeconds));
    }

    private PlatformDeployment requireState(Long deploymentId, PlatformDeploymentState expected) {
        PlatformDeployment current = deployments.selectOneById(deploymentId);
        if (current == null || current.getState() == null
            || !expected.name().equals(current.getState())) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "部署当前状态不允许该推进");
        }
        return current;
    }
}