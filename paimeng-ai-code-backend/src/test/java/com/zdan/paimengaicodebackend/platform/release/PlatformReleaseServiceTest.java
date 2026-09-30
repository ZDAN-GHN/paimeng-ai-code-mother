package com.zdan.paimengaicodebackend.platform.release;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformDeploymentMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformReleaseMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentProperties;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentStage;
import com.zdan.paimengaicodebackend.platform.deployment.PlatformDeploymentState;
import com.zdan.paimengaicodebackend.platform.domain.PlatformTaskLifecycleService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import com.zdan.paimengaicodebackend.platform.entity.SourceRevision;
import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * 首次发布的三条不可退让的约束（Issue #81 / T-09）：
 *
 * <ol>
 *   <li>AC-019：首次 validated 版本自动创建固定 Release 并排期部署；</li>
 *   <li>AD-011：已上线 Application 的后续版本不得自动上线，必须等 Owner 确认；</li>
 *   <li>幂等：晋升重放不得产生第二个固定版本或第二次部署。</li>
 * </ol>
 */
class PlatformReleaseServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long TASK_ID = 460017668615995394L;

    private final AppMapper apps = mock(AppMapper.class);
    private final PlatformReleaseMapper releases = mock(PlatformReleaseMapper.class);
    private final PlatformDeploymentMapper deployments = mock(PlatformDeploymentMapper.class);
    private final PlatformTaskLifecycleService lifecycle = mock(PlatformTaskLifecycleService.class);
    private final PlatformDeploymentProperties properties = new PlatformDeploymentProperties();

    private PlatformReleaseService service;

    @BeforeEach
    void setUp() {
        service = new PlatformReleaseService(apps, releases, deployments, lifecycle, properties);
        when(apps.lockApplication(APPLICATION_ID)).thenReturn(APPLICATION_ID);
        when(apps.selectOneById(APPLICATION_ID)).thenReturn(activeApplication());
        when(releases.selectOneByQuery(any())).thenReturn(null);
        when(releases.insert(any(PlatformRelease.class))).thenReturn(1);
        when(deployments.insert(any(PlatformDeployment.class))).thenAnswer(invocation -> {
            invocation.<PlatformDeployment>getArgument(0).setId(9001L);
            return 1;
        });
    }

    @Test
    void firstValidatedVersionCreatesFixedReleaseAndSchedulesDeployment() {
        SourceRevision revision = revision();

        Optional<PlatformReleaseService.Outcome> outcome = service.releaseFirstVersion(revision);

        assertTrue(outcome.isPresent());
        assertTrue(outcome.get().created());
        assertEquals(PlatformReleaseService.releaseId(revision), outcome.get().releaseId());
        assertEquals(9001L, outcome.get().deploymentId());

        ArgumentCaptor<PlatformRelease> release = ArgumentCaptor.forClass(PlatformRelease.class);
        verify(releases).insert(release.capture());
        assertEquals(revision.getId(), release.getValue().getSourceRevisionId());
        assertEquals(revision.getCommitHash(), release.getValue().getCommitHash());
        assertEquals(revision.getTreeHash(), release.getValue().getTreeHash());
        assertEquals(revision.getProfileVersionId(), release.getValue().getProfileVersionId());
        // runtimeProfile 必须被钉进不可变 Release：事后改配置不能静默改变已发布版本的运行语义。
        assertEquals(properties.getRuntimeProfile(), release.getValue().getRuntimeProfile());

        ArgumentCaptor<PlatformDeployment> deployment = ArgumentCaptor.forClass(PlatformDeployment.class);
        verify(deployments).insert(deployment.capture());
        assertEquals(PlatformDeploymentState.PENDING.name(), deployment.getValue().getState());
        assertEquals(PlatformDeploymentStage.RELEASED.name(), deployment.getValue().getStage());
        assertEquals(revision.getTaskId(), deployment.getValue().getTaskId());

        verify(lifecycle).markReleased(eq(TASK_ID), eq("FIRST_RELEASE_CREATED"),
            eq(outcome.get().releaseId()), any());
    }

    @Test
    void subsequentVersionIsNotAutoReleased() {
        when(releases.countForOtherTasks(APPLICATION_ID, TASK_ID)).thenReturn(1);

        assertTrue(service.releaseFirstVersion(revision()).isEmpty());

        verify(releases, never()).insert(any());
        verify(deployments, never()).insert(any());
        verify(lifecycle, never()).markReleased(any(), any(), any(), any());
    }

    @Test
    void promotionReplayReturnsTheSameReleaseWithoutCreatingASecondDeployment() {
        SourceRevision revision = revision();
        PlatformRelease existing = releaseOf(revision);
        PlatformDeployment existingDeployment = new PlatformDeployment();
        existingDeployment.setId(9001L);
        existingDeployment.setReleaseId(existing.getId());
        when(releases.selectOneByQuery(any())).thenReturn(existing);
        when(deployments.selectOneByQuery(any())).thenReturn(existingDeployment);

        Optional<PlatformReleaseService.Outcome> outcome = service.releaseFirstVersion(revision);

        assertTrue(outcome.isPresent());
        assertFalse(outcome.get().created());
        verify(releases, never()).insert(any());
        verify(deployments, never()).insert(any());
        verify(lifecycle, never()).markReleased(any(), any(), any(), any());
    }

    @Test
    void replayWithADifferentProfileIsRejectedInsteadOfSilentlyTrustingTheStoredRow() {
        SourceRevision revision = revision();
        PlatformRelease existing = releaseOf(revision);
        existing.setProfileVersionId(9999L);
        when(releases.selectOneByQuery(any())).thenReturn(existing);

        assertThrows(BusinessException.class, () -> service.releaseFirstVersion(revision));
        verify(lifecycle, never()).markReleased(any(), any(), any(), any());
    }

    @Test
    void archivedApplicationCannotBeReleased() {
        App archived = activeApplication();
        archived.setLifecycleStatus("ARCHIVED");
        when(apps.selectOneById(APPLICATION_ID)).thenReturn(archived);

        assertThrows(BusinessException.class, () -> service.releaseFirstVersion(revision()));

        verify(releases, never()).insert(any());
        verify(deployments, never()).insert(any());
    }

    @Test
    void applicationWithoutThePromotedStableRevisionCannotBeReleased() {
        App withoutBaseline = activeApplication();
        withoutBaseline.setStableSourceRevision(null);
        when(apps.selectOneById(APPLICATION_ID)).thenReturn(withoutBaseline);

        assertThrows(BusinessException.class, () -> service.releaseFirstVersion(revision()));
    }

    @Test
    void runtimeProfileMustBeAWhitelistedName() {
        properties.setRuntimeProfile("node 20");

        assertThrows(BusinessException.class, () -> service.releaseFirstVersion(revision()));
        verify(releases, never()).insert(any());
    }

    @Test
    void incompletePromotionResultNeverProducesARelease() {
        SourceRevision revision = revision();
        revision.setValidationAttemptId(null);

        // 注意传局部变量而不是再调一次 revision()：后者会拿到一个完整晋升结果，测的就不是这条分支了。
        assertThrows(BusinessException.class, () -> service.releaseFirstVersion(revision));
        verify(apps, never()).lockApplication(anyLong());
    }

    private SourceRevision revision() {
        SourceRevision revision = new SourceRevision();
        revision.setId("11111111-2222-3333-4444-555555555555");
        revision.setApplicationId(APPLICATION_ID);
        revision.setTaskId(TASK_ID);
        revision.setRunId("run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64");
        revision.setBaselineHash("a".repeat(64));
        revision.setCommitHash("b".repeat(40));
        revision.setTreeHash("c".repeat(40));
        revision.setProfileVersionId(7L);
        revision.setValidationAttemptId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        return revision;
    }

    private PlatformRelease releaseOf(SourceRevision revision) {
        PlatformRelease release = new PlatformRelease();
        release.setId(PlatformReleaseService.releaseId(revision));
        release.setApplicationId(revision.getApplicationId());
        release.setTaskId(revision.getTaskId());
        release.setRunId(revision.getRunId());
        release.setSourceRevisionId(revision.getId());
        release.setProfileVersionId(revision.getProfileVersionId());
        release.setBaselineHash(revision.getBaselineHash());
        release.setCommitHash(revision.getCommitHash());
        release.setTreeHash(revision.getTreeHash());
        release.setValidationAttemptId(revision.getValidationAttemptId());
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