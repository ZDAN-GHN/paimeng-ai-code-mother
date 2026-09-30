package com.zdan.paimengaicodebackend.platform.deployment;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProductionAccessGuard;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Deployment 状态裁决（Issue #81 / T-09）
 *
 * <p>重点覆盖两条边界：只有 Platform 能推进（AD-016），以及终态必须由带前置状态的 CAS 落库，
 * 调用方不能自称处在 PROVISIONING。
 */
class PlatformDeploymentStateServiceTest {

    private final PlatformDeploymentMapper deployments = mock(PlatformDeploymentMapper.class);
    private final PlatformDeploymentStateMachine stateMachine = new PlatformDeploymentStateMachine();
    private final PlatformProductionAccessGuard productionGuard = new PlatformProductionAccessGuard();

    private PlatformDeploymentStateService service;

    @BeforeEach
    void setUp() {
        service = new PlatformDeploymentStateService(deployments, stateMachine, productionGuard);
    }

    @Test
    void claimMovesPendingToProvisioningExactlyOnce() {
        when(deployments.selectClaimableId()).thenReturn(42L);
        when(deployments.claim(42L)).thenReturn(1);
        when(deployments.selectOneById(42L)).thenReturn(deployment("PROVISIONING"));

        Optional<PlatformDeployment> claimed = service.claimNext();

        assertTrue(claimed.isPresent());
        verify(deployments).claim(42L);
    }

    @Test
    void lostClaimRaceReturnsEmptyInsteadOfRunningTheSameDeploymentTwice() {
        when(deployments.selectClaimableId()).thenReturn(42L);
        when(deployments.claim(42L)).thenReturn(0);

        assertTrue(service.claimNext().isEmpty());
        verify(deployments, never()).selectOneById(any());
    }

    @Test
    void emptyQueueIsNotAFailure() {
        when(deployments.selectClaimableId()).thenReturn(null);

        assertTrue(service.claimNext().isEmpty());
    }

    @Test
    void healthyRequiresProvisioningPrecondition() {
        when(deployments.selectOneById(42L)).thenReturn(deployment("PENDING"));
        when(deployments.markHealthy(anyLong(), anyString(), anyString())).thenReturn(1);

        assertThrows(BusinessException.class,
            () -> service.markHealthy(42L, "container", "172.18.0.9"));
        verify(deployments, never()).markHealthy(anyLong(), anyString(), anyString());
    }

    @Test
    void healthyWritesTheInternalAddressAsContainerEvidence() {
        when(deployments.selectOneById(42L)).thenReturn(deployment("PROVISIONING"));
        when(deployments.markHealthy(anyLong(), anyString(), anyString())).thenReturn(1);

        service.markHealthy(42L, "container-1", "172.18.0.9");

        verify(deployments).markHealthy(42L, "container-1", "172.18.0.9");
    }

    @Test
    void unhealthyRequiresAWhitelistedReasonCode() {
        when(deployments.selectOneById(42L)).thenReturn(deployment("PROVISIONING"));

        assertThrows(BusinessException.class, () -> service.markUnhealthy(42L,
            PlatformDeploymentStage.UNHEALTHY, null, "container-1", "172.18.0.9"));
        assertThrows(BusinessException.class, () -> service.markUnhealthy(42L,
            null, PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED, null, null));
        verify(deployments, never()).markUnhealthy(anyLong(), any(), any(), any(), any());
    }

    @Test
    void lostCasRaceCannotOverwriteAnAlreadySettledDeployment() {
        when(deployments.selectOneById(42L)).thenReturn(deployment("PROVISIONING"));
        when(deployments.markUnhealthy(anyLong(), any(), any(), any(), any())).thenReturn(0);

        assertThrows(BusinessException.class, () -> service.markUnhealthy(42L,
            PlatformDeploymentStage.UNHEALTHY, PlatformDeploymentReasonCode.HEALTH_PROBE_FAILED, null, null));
    }

    @Test
    void agentCannotTouchTheProductionDeploymentPath() {
        assertThrows(BusinessException.class,
            () -> productionGuard.requirePlatformActor(PlatformActor.AGENT));
        assertThrows(BusinessException.class,
            () -> productionGuard.requirePlatformActor(PlatformActor.OWNER));
        assertThrows(BusinessException.class,
            () -> productionGuard.requirePlatformActor(PlatformActor.SYSTEM_ADMINISTRATOR));
        productionGuard.requirePlatformActor(PlatformActor.PLATFORM);
    }

    @Test
    void onlyRegisteredReasonCodesArePublishable() {
        assertTrue(productionGuard.isPublishableReasonCode("HEALTH_PROBE_FAILED"));
        assertTrue(productionGuard.isPublishableReasonCode("health_probe_failed"));
        org.junit.jupiter.api.Assertions.assertFalse(
            productionGuard.isPublishableReasonCode("password=hunter2 failed"));
        org.junit.jupiter.api.Assertions.assertFalse(productionGuard.isPublishableReasonCode(null));
    }

    @Test
    void terminalDeploymentStatesCannotMoveAgain() {
        assertThrows(BusinessException.class, () -> stateMachine.assertTransition(
            PlatformDeploymentState.HEALTHY, PlatformDeploymentState.UNHEALTHY, PlatformActor.PLATFORM));
        assertThrows(BusinessException.class, () -> stateMachine.assertTransition(
            PlatformDeploymentState.UNHEALTHY, PlatformDeploymentState.HEALTHY, PlatformActor.PLATFORM));
        assertThrows(BusinessException.class, () -> stateMachine.assertTransition(
            PlatformDeploymentState.PENDING, PlatformDeploymentState.HEALTHY, PlatformActor.PLATFORM));
        assertThrows(BusinessException.class, () -> stateMachine.assertTransition(
            PlatformDeploymentState.PENDING, PlatformDeploymentState.PROVISIONING, PlatformActor.AGENT));
    }

    @Test
    void staleProvisioningIsReclaimedWithABoundedThreshold() {
        assertThrows(BusinessException.class, () -> service.reclaimStale(0));
        when(deployments.reclaimStale(any())).thenReturn(1);

        assertEquals(1, service.reclaimStale(600));
    }

    private PlatformDeployment deployment(String state) {
        PlatformDeployment deployment = new PlatformDeployment();
        deployment.setId(42L);
        deployment.setApplicationId(460017668615995392L);
        deployment.setReleaseId("rel-0123456789abcdef0123456789abcdef");
        deployment.setTaskId(460017668615995394L);
        deployment.setState(state);
        return deployment;
    }
}