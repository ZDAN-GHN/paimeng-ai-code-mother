package com.zdan.paimengaicodebackend.platform.deployment;

import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 受控部署的轮询驱动（Issue #81 / T-09）
 *
 * <p>部署是 Platform 内部职责，AD-016 明确 Agent 不能创建、停止、检查或回滚 Deployment，
 * 因此不存在任何触发部署的对外端点，只能由这里的调度器推进。轮询间隔只影响排队快慢，
 * 不改变任何状态语义。
 */
@Slf4j
@Component
@ConditionalOnProperty(prefix = "platform.deployment", name = "enabled", havingValue = "true")
public class PlatformDeploymentScheduler {

    private final PlatformDeploymentService deploymentService;

    public PlatformDeploymentScheduler(PlatformDeploymentService deploymentService) {
        this.deploymentService = deploymentService;
    }

    @Scheduled(fixedDelayString = "${platform.deployment.poll-interval-ms:5000}")
    public void settleOnce() {
        try {
            deploymentService.reclaimStale();
            Optional<PlatformDeploymentService.Outcome> settled = deploymentService.settleNext();
            settled.ifPresent(outcome -> log.info(
                "Platform deployment settled, deploymentId: {}, state: {}, reasonCode: {}, result: success",
                outcome.deploymentId(), outcome.state(), outcome.reasonCode()));
        } catch (RuntimeException failure) {
            // 单次推进失败不终止轮询：行会停在 PROVISIONING，僵死回收会把它放回队列。
            log.error("Platform deployment settlement failed, result: failure", failure);
        }
    }
}