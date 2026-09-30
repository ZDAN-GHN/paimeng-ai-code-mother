package com.zdan.paimengaicodebackend.platform.deployment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import com.zdan.paimengaicodebackend.platform.release.PlatformReleaseService;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 首次部署的成功与失败路径（Issue #81 / T-09）
 *
 * <p>本切片验收里最容易写错的两条断言：健康通过才允许上线；未健康必须既不存在健康公开路径，
 * 也不动 Trusted Profile 与 SourceRevision（AC-022）。
 */
class PlatformDeploymentServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long TASK_ID = 460017668615995394L;
    private static final String RELEASE_ID = "rel-0123456789abcdef0123456789abcdef";

    private final PlatformDeploymentStateService states = mock(PlatformDeploymentStateService.class);
    private final PlatformDeploymentMapper deployments = mock(PlatformDeploymentMapper.class);
    private final PlatformReleaseService releaseService = mock(PlatformReleaseService.class);
    private final PlatformDeploymentExecutor executor = mock(PlatformDeploymentExecutor.class);
    private final PlatformDeploymentHealthProbe probe = mock(PlatformDeploymentHealthProbe.class);
    private final PlatformDeploymentProperties properties = new PlatformDeploymentProperties();
    private final AppMapper apps = mock(AppMapper.class);

    private PlatformDeploymentService service;

    @BeforeEach
    void setUp() {
        properties.setProbeRetryIntervalMs(50L);
        properties.setReadinessDeadlineSeconds(1);
        service = new PlatformDeploymentService(
            states, deployments, releaseService, executor, probe, properties, apps);
        when(apps.selectOneById(APPLICATION_ID)).thenReturn(activeApplication());
        when(releaseService.requireById(APPLICATION_ID, RELEASE_ID)).thenReturn(release());
        when(executor.start(APPLICATION_ID, RELEASE_ID))
            .thenReturn(new PlatformDeploymentExecutor.Handle("container-1", "172.18.0.9"));
        when(executor.isRunning("container-1")).thenReturn(true);
        when(deployments.selectOneById(7L)).thenReturn(healthyRow());
    }

    @Test
    void healthyProbeMakesTheDeploymentTheOnlySourceOfLiveState() {
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(probe.probe("172.18.0.9", properties.getInternalPort()))
            .thenReturn(PlatformDeploymentHealthProbe.Outcome.HEALTHY);

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentState.HEALTHY.name(), outcome.state());
        org.junit.jupiter.api.Assertions.assertNull(outcome.reasonCode());
        verify(states).markHealthy(7L, "container-1", "172.18.0.9");
        // 健康的容器必须留着：公开入口指向的就是它。
        verify(executor, never()).stop(any(), any());
    }

    @Test
    void failedHealthProbeLeavesNoHealthyDeploymentAndNoPublicRoute() {
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(probe.probe("172.18.0.9", properties.getInternalPort()))
            .thenReturn(PlatformDeploymentHealthProbe.Outcome.FAILED);
        // 未健康后再次读取时不存在健康 Deployment——这正是「没有健康公开 URL」的落点。
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentState.UNHEALTHY.name(), outcome.state());
        assertEquals(PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED.name(), outcome.reasonCode());
        verify(states, never()).markHealthy(any(), any(), any());
        // 未通过的容器没有继续跑的理由。
        verify(executor).stop("container-1", RELEASE_ID);
    }

    @Test
    void readinessDeadlineIsBoundedAndReportedAsTimeout() {
        properties.setProbeRequestTimeoutSeconds(1);
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(probe.probe("172.18.0.9", properties.getInternalPort()))
            .thenReturn(PlatformDeploymentHealthProbe.Outcome.TIMED_OUT);
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentReasonCode.HEALTH_PROBE_TIMEOUT.name(), outcome.reasonCode());
        verify(executor).stop("container-1", RELEASE_ID);
    }

    @Test
    void exitedContainerFailsFastInsteadOfWaitingForTheDeadline() {
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(executor.isRunning("container-1")).thenReturn(false);
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentReasonCode.CONTAINER_START_FAILED.name(), outcome.reasonCode());
        verify(probe, never()).probe(any(), anyInt());
    }

    @Test
    void archivedApplicationIsNeverDeployed() {
        App archived = activeApplication();
        archived.setLifecycleStatus("ARCHIVED");
        when(apps.selectOneById(APPLICATION_ID)).thenReturn(archived);
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentReasonCode.APPLICATION_NOT_ACTIVE.name(), outcome.reasonCode());
        verify(executor, never()).start(any(), any());
    }

    @Test
    void runtimeProfileDriftBlocksDeploymentInsteadOfSilentlyChangingRuntimeSemantics() {
        PlatformRelease drifted = release();
        drifted.setRuntimeProfile("NODE_18");
        when(releaseService.requireById(APPLICATION_ID, RELEASE_ID)).thenReturn(drifted);
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        PlatformDeploymentService.Outcome outcome = service.settleNext().orElseThrow();

        assertEquals(PlatformDeploymentReasonCode.RUNTIME_IMAGE_UNAVAILABLE.name(), outcome.reasonCode());
        verify(executor, never()).start(any(), any());
    }

    @Test
    void emptyQueueSettlesNothing() {
        when(states.claimNext()).thenReturn(Optional.empty());

        assertTrue(service.settleNext().isEmpty());
        verify(executor, never()).start(any(), any());
    }

    @Test
    void reclaimIsDrivenByPlatformConfiguration() {
        when(states.reclaimStale(any(Integer.class))).thenReturn(0);

        assertEquals(0, service.reclaimStale());
        verify(states).reclaimStale(properties.getStaleProvisioningSeconds());
    }

    @Test
    void failedDeploymentNeverTouchesTheStableSourceRevision() {
        when(states.claimNext()).thenReturn(Optional.of(provisioningDeployment()));
        when(probe.probe("172.18.0.9", properties.getInternalPort()))
            .thenReturn(PlatformDeploymentHealthProbe.Outcome.FAILED);
        when(deployments.selectOneById(7L)).thenReturn(unhealthyRow());

        service.settleNext().orElseThrow();

        // AC-022：Deployment 失败只改变 Deployment 状态。Profile 与 SourceRevision 由晋升单独表达，
        // 这里断言部署路径完全没有写过 app 表。
        verify(apps, never()).updateByQuery(any(), any(Boolean.class), any());
        verify(deployments, never()).updateByQuery(any(), any(Boolean.class), any());
    }

    private PlatformDeployment provisioningDeployment() {
        PlatformDeployment deployment = new PlatformDeployment();
        deployment.setId(7L);
        deployment.setApplicationId(APPLICATION_ID);
        deployment.setTaskId(TASK_ID);
        deployment.setReleaseId(RELEASE_ID);
        deployment.setState(PlatformDeploymentState.PROVISIONING.name());
        deployment.setStage(PlatformDeploymentStage.PROVISIONING.name());
        deployment.setAttemptNumber(1);
        return deployment;
    }

    private PlatformDeployment healthyRow() {
        PlatformDeployment deployment = provisioningDeployment();
        deployment.setState(PlatformDeploymentState.HEALTHY.name());
        deployment.setStage(PlatformDeploymentStage.HEALTHY.name());
        deployment.setContainerAddress("172.18.0.9");
        return deployment;
    }

    private PlatformDeployment unhealthyRow() {
        PlatformDeployment deployment = provisioningDeployment();
        deployment.setState(PlatformDeploymentState.UNHEALTHY.name());
        deployment.setStage(PlatformDeploymentStage.UNHEALTHY.name());
        deployment.setReasonCode(PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED.name());
        return deployment;
    }

    private PlatformRelease release() {
        PlatformRelease release = new PlatformRelease();
        release.setId(RELEASE_ID);
        release.setApplicationId(APPLICATION_ID);
        release.setTaskId(TASK_ID);
        release.setRuntimeProfile(properties.getRuntimeProfile());
        return release;
    }

    private App activeApplication() {
        App application = new App();
        application.setId(APPLICATION_ID);
        application.setLifecycleStatus("ACTIVE");
        application.setIsDelete(0);
        application.setStableSourceRevision("11111111-2222-3333-4444-555555555555");
        return application;
    }
}