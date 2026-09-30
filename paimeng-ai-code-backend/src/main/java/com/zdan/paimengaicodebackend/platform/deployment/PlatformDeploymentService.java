package com.zdan.paimengaicodebackend.platform.deployment;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import com.zdan.paimengaicodebackend.platform.release.PlatformReleaseService;
import java.util.Objects;
import java.util.Optional;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * 固定 Release 的部署执行（Issue #81 / T-09）
 *
 * <p>CT-005：Platform 独占生产构建与部署。执行顺序固定为「读取固定 Release → 确认 Application
 * 仍可上线 → 启动独立容器 → 内部网络健康检查 → 落终态」。健康通过之前没有任何代码路径会把
 * 这个 Application 标记为已上线，也没有代码路径会把它挂到公开路径上。
 *
 * <p>AC-022：未健康只改变 Deployment 状态。这里刻意不触碰 Trusted Profile Version、
 * SourceRevision 与应用数据——「回滚」不是「撤销基线」，这两件事混在一起会让一次部署失败
 * 变成无法解释的数据回退。
 */
@Slf4j
@Service
public class PlatformDeploymentService {

    /** 一次部署推进的对外结论。 */
    public record Outcome(Long deploymentId, String state, String reasonCode) { }

    private final PlatformDeploymentStateService deploymentStates;
    private final PlatformDeploymentMapper deployments;
    private final PlatformReleaseService releaseService;
    private final PlatformDeploymentExecutor executor;
    private final PlatformDeploymentHealthProbe probe;
    private final PlatformDeploymentProperties properties;
    private final AppMapper apps;

    public PlatformDeploymentService(
        PlatformDeploymentStateService deploymentStates,
        PlatformDeploymentMapper deployments,
        PlatformReleaseService releaseService,
        PlatformDeploymentExecutor executor,
        PlatformDeploymentHealthProbe probe,
        PlatformDeploymentProperties properties,
        AppMapper apps
    ) {
        this.deploymentStates = deploymentStates;
        this.deployments = deployments;
        this.releaseService = releaseService;
        this.executor = executor;
        this.probe = probe;
        this.properties = properties;
        this.apps = apps;
    }

    /** 把所有僵死的 PROVISIONING 放回队列。由轮询驱动反复调用，幂等。 */
    public int reclaimStale() {
        return deploymentStates.reclaimStale(properties.getStaleProvisioningSeconds());
    }

    /** 领取并把一条部署推进到终态。没有待执行部署时返回空值。 */
    public Optional<Outcome> settleNext() {
        return deploymentStates.claimNext().map(this::settle);
    }

    /**
     * 执行一次部署并落终态。
     *
     * <p>本方法<b>不在事务中</b>：Docker 调用不该持有数据库行锁。终态写入由
     * {@link PlatformDeploymentStateService} 各自开事务完成。
     */
    private Outcome settle(PlatformDeployment deployment) {
        PlatformRelease release;
        try {
            release = releaseService.requireById(deployment.getApplicationId(), deployment.getReleaseId());
        } catch (BusinessException unreadable) {
            log.error("Platform deployment release unreadable, deploymentId: {}, releaseId: {}, cause: {}",
                deployment.getId(), deployment.getReleaseId(), unreadable.getMessage());
            return fail(deployment, PlatformDeploymentReasonCode.APPLICATION_NOT_ACTIVE);
        }

        App application = apps.selectOneById(deployment.getApplicationId());
        if (application == null || !"ACTIVE".equals(application.getLifecycleStatus())
            || !Objects.equals(application.getIsDelete(), 0)) {
            return fail(deployment, PlatformDeploymentReasonCode.APPLICATION_NOT_ACTIVE);
        }
        if (!release.getRuntimeProfile().equals(properties.getRuntimeProfile())) {
            // 固定 Release 钉住的运行时契约与当前配置不一致：宁可不上线，也不悄悄换一套运行语义。
            log.error("Platform deployment runtime profile mismatch, deploymentId: {}, releaseProfile: {}, configured: {}",
                deployment.getId(), release.getRuntimeProfile(), properties.getRuntimeProfile());
            return fail(deployment, PlatformDeploymentReasonCode.RUNTIME_IMAGE_UNAVAILABLE);
        }

        PlatformDeploymentExecutor.Handle handle;
        try {
            handle = executor.start(deployment.getApplicationId(), deployment.getReleaseId());
        } catch (PlatformDeploymentFailureException controlled) {
            log.error("Platform deployment start failed, deploymentId: {}, reasonCode: {}, cause: {}",
                deployment.getId(), controlled.reasonCode(), controlled.getMessage());
            return fail(deployment, controlled.reasonCode());
        }

        try {
            return awaitHealth(deployment, handle);
        } finally {
            // 失败路径的容器必须清理：一个不对外提供服务却仍在消耗资源的容器没有任何保留理由。
            if (!isHealthy(deployment.getId())) {
                executor.stop(handle.containerId(), deployment.getReleaseId());
            }
        }
    }

    private Outcome awaitHealth(PlatformDeployment deployment, PlatformDeploymentExecutor.Handle handle) {
        long deadlineNanos = System.nanoTime()
            + properties.getReadinessDeadlineSeconds() * 1_000_000_000L;
        PlatformDeploymentHealthProbe.Outcome last = PlatformDeploymentHealthProbe.Outcome.FAILED;
        while (true) {
            if (!executor.isRunning(handle.containerId())) {
                // 容器已退出：继续探测只会等到超时，失败原因也更接近真实。
                return fail(deployment, PlatformDeploymentReasonCode.CONTAINER_START_FAILED,
                    handle.containerId(), handle.address());
            }
            last = probe.probe(handle.address(), properties.getInternalPort());
            if (last == PlatformDeploymentHealthProbe.Outcome.HEALTHY) {
                deploymentStates.markHealthy(deployment.getId(), handle.containerId(), handle.address());
                log.info(
                    "Platform deployment healthy, applicationId: {}, deploymentId: {}, releaseId: {}, attempt: {}, result: success",
                    deployment.getApplicationId(), deployment.getId(), deployment.getReleaseId(),
                    deployment.getAttemptNumber());
                return new Outcome(deployment.getId(),
                    PlatformDeploymentState.HEALTHY.name(), null);
            }
            if (System.nanoTime() >= deadlineNanos) {
                PlatformDeploymentReasonCode reason = last == PlatformDeploymentHealthProbe.Outcome.TIMED_OUT
                    ? PlatformDeploymentReasonCode.HEALTH_PROBE_TIMEOUT
                    : PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED;
                log.error(
                    "Platform deployment health probe did not pass, applicationId: {}, deploymentId: {}, reasonCode: {}, attempt: {}, result: failure",
                    deployment.getApplicationId(), deployment.getId(), reason, deployment.getAttemptNumber());
                return fail(deployment, reason, handle.containerId(), handle.address());
            }
            sleepBetweenProbes();
        }
    }

    private void sleepBetweenProbes() {
        try {
            Thread.sleep(Math.max(50L, properties.getProbeRetryIntervalMs()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new PlatformDeploymentFailureException(
                PlatformDeploymentReasonCode.HEALTH_PROBE_TIMEOUT, "健康探测被中断");
        }
    }

    private Outcome fail(PlatformDeployment deployment, PlatformDeploymentReasonCode reasonCode) {
        return fail(deployment, reasonCode, null, null);
    }

    private Outcome fail(
        PlatformDeployment deployment,
        PlatformDeploymentReasonCode reasonCode,
        String containerId,
        String containerAddress
    ) {
        deploymentStates.markUnhealthy(deployment.getId(), PlatformDeploymentStage.UNHEALTHY, reasonCode,
            containerId, containerAddress);
        return new Outcome(deployment.getId(), PlatformDeploymentState.UNHEALTHY.name(), reasonCode.name());
    }

    private boolean isHealthy(Long deploymentId) {
        PlatformDeployment current = deployments.selectOneById(deploymentId);
        return current != null && PlatformDeploymentState.HEALTHY.name().equals(current.getState());
    }
}