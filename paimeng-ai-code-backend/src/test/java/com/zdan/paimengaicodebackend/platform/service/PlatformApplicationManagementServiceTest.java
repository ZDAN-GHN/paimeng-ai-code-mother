package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationArchiveService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationAccessGuard;
import com.zdan.paimengaicodebackend.platform.domain.PlatformRequirementNormalizationService;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationInitialRequirementVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import com.mybatisflex.core.paginate.Page;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class PlatformApplicationManagementServiceTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long OWNER_ID = 377708067863715840L;

    @Mock
    private AppMapper appMapper;

    @Mock
    private PlatformRequirementMapper requirementMapper;

    @Mock
    private PlatformApplicationAccessGuard accessGuard;

    @Mock
    private PlatformApplicationArchiveService archiveService;

    @Mock
    private PlatformRequirementNormalizationService normalizationService;

    private PlatformApplicationManagementService managementService;

    @BeforeEach
    void setUp() {
        managementService = new PlatformApplicationManagementService(
            appMapper,
            requirementMapper,
            archiveService,
            accessGuard,
            normalizationService
        );
        // 主体身份与 Application 归属判定由 PlatformApplicationAccessGuard 单独负责；这里给出
        // 与真实实现行为一致的默认桩，让本测试只关注 ManagementService 自身的行为。
        lenient().when(accessGuard.requireActorId(any(User.class)))
            .thenAnswer(invocation -> ((User) invocation.getArgument(0)).getId());
        lenient().when(accessGuard.actorFor(any(User.class))).thenAnswer(invocation ->
            "admin".equals(((User) invocation.getArgument(0)).getUserRole())
                ? PlatformActor.SYSTEM_ADMINISTRATOR
                : PlatformActor.OWNER);
        lenient().when(accessGuard.requireManaged(eq(APPLICATION_ID), any(User.class))).thenReturn(application());
        lenient().when(accessGuard.requireReadable(eq(APPLICATION_ID), any(User.class))).thenReturn(application());
        lenient().when(normalizationService.normalizationStatus(any(), any())).thenReturn("PENDING_NORMALIZATION");
    }

    @Test
    void ownerCreatesApplicationForSelf() {
        User owner = user(OWNER_ID, "user");

        PlatformApplicationVO result = managementService.createApplication(owner, "  Product  ");

        ArgumentCaptor<App> applicationCaptor = ArgumentCaptor.forClass(
            App.class
        );
        verify(appMapper).insertSelective(applicationCaptor.capture());
        assertEquals(OWNER_ID, applicationCaptor.getValue().getUserId());
        assertEquals("Product", applicationCaptor.getValue().getAppName());
        assertEquals("ACTIVE", result.getLifecycleStatus());
    }

    @Test
    void ownerSubmitsUnchangedRequirementWithPendingNormalizationStatus() {
        App application = application();
        User owner = user(OWNER_ID, "user");
        String originalText = "  保留这段原文  ";

        PlatformRequirementVO result = managementService.submitRequirement(
            APPLICATION_ID,
            owner,
            originalText
        );

        ArgumentCaptor<PlatformRequirement> requirementCaptor = ArgumentCaptor.forClass(
            PlatformRequirement.class
        );
        verify(requirementMapper).insertSelective(requirementCaptor.capture());
        assertEquals(originalText, requirementCaptor.getValue().getOriginalText());
        assertEquals(originalText, result.getOriginalText());
        assertEquals("PENDING_NORMALIZATION", result.getNormalizationStatus());
        // Requirement 一落库就必须有人负责归一化，否则「等待归一化」只是前端文案。
        verify(normalizationService).openNormalization(eq(APPLICATION_ID), any(PlatformRequirement.class), any(String.class));
    }

    @Test
    void requirementNormalizationStatusProjectsRealQueueState() {
        App application = application();
        doAnswer(invocation -> {
            invocation.getArgument(0, PlatformRequirement.class).setId(911L);
            return 1;
        }).when(requirementMapper).insertSelective(any(PlatformRequirement.class));
        when(normalizationService.normalizationStatus(any(), any())).thenReturn("BLOCKED");

        PlatformRequirementVO result = managementService.submitRequirement(
            APPLICATION_ID,
            user(OWNER_ID, "user"),
            "预约系统"
        );

        assertEquals("BLOCKED", result.getNormalizationStatus());
        assertEquals("OWNER_REQUEST", result.getKind());
    }

    @Test
    void homepageCreationPersistsApplicationAndInitialRequirementInOneServiceOperation() {
        User owner = user(OWNER_ID, "user");
        doAnswer(invocation -> {
            invocation.getArgument(0, App.class).setId(APPLICATION_ID);
            return 1;
        })
            .when(appMapper)
            .insertSelective(any(App.class));

        PlatformApplicationInitialRequirementVO result = managementService.createApplicationWithInitialRequirement(
            owner,
            "Product",
            "Build it"
        );

        verify(appMapper).insertSelective(any(App.class));
        verify(requirementMapper).insertSelective(any(PlatformRequirement.class));
        assertEquals(String.valueOf(APPLICATION_ID), result.getApplication().getId());
        assertEquals("Build it", result.getRequirement().getOriginalText());
        assertEquals("PENDING_NORMALIZATION", result.getRequirement().getNormalizationStatus());
    }

    @Test
    void ownerListsApplicationsTheyCreatedForRetentionVisibility() {
        Page<App> applications = new Page<>(1, 12, 1);
        applications.setRecords(List.of(application()));
        when(appMapper.paginate(any(Page.class), any())).thenReturn(applications);

        Page<PlatformApplicationVO> result = managementService.listMyApplications(
            user(OWNER_ID, "user"),
            1,
            12
        );

        assertEquals(1, result.getRecords().size());
        assertEquals(String.valueOf(APPLICATION_ID), result.getRecords().getFirst().getId());
    }

    @Test
    void ownerCanListArchivedApplicationWithUnavailableState() {
        App archivedApplication = application();
        archivedApplication.setLifecycleStatus("ARCHIVED");
        Page<App> applications = new Page<>(1, 12, 1);
        applications.setRecords(List.of(archivedApplication));
        when(appMapper.paginate(any(Page.class), any())).thenReturn(applications);

        PlatformApplicationVO result = managementService.listMyApplications(
            user(OWNER_ID, "user"),
            1,
            12
        ).getRecords().getFirst();

        assertEquals("ARCHIVED", result.getLifecycleStatus());
        assertEquals("UNAVAILABLE", result.getPublicAvailability());
        assertEquals(true, result.isRetained());
        assertEquals(false, result.isRecoverySupported());
    }

    @Test
    void ownerListsRequirementHistoryForTheirApplication() {
        Page<PlatformRequirement> requirements = new Page<>(1, 20, 1);
        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setId(301L);
        requirement.setApplicationId(APPLICATION_ID);
        requirement.setOriginalText("Build it");
        requirements.setRecords(List.of(requirement));
        when(requirementMapper.paginate(any(Page.class), any())).thenReturn(requirements);

        Page<PlatformRequirementVO> result = managementService.listRequirements(
            APPLICATION_ID,
            user(OWNER_ID, "user"),
            1,
            20
        );

        assertEquals(1, result.getRecords().size());
        assertEquals("Build it", result.getRecords().getFirst().getOriginalText());
    }

    @Test
    void rejectsBlankApplicationNameAndRequirementText() {
        User owner = user(OWNER_ID, "user");

        assertThrows(
            BusinessException.class,
            () -> managementService.createApplication(owner, "  \t")
        );
        assertThrows(
            BusinessException.class,
            () -> managementService.submitRequirement(APPLICATION_ID, owner, "  \n")
        );
    }

    @Test
    void ownerAndAdministratorBothReachTheApplicationThroughTheSameGuard() {
        App application = application();

        PlatformApplicationVO ownerView = managementService.getApplication(APPLICATION_ID, user(OWNER_ID, "user"));
        PlatformApplicationVO adminView = managementService.getApplication(APPLICATION_ID, user(999L, "admin"));

        assertEquals(String.valueOf(APPLICATION_ID), ownerView.getId());
        assertEquals(String.valueOf(APPLICATION_ID), adminView.getId());
    }

    @Test
    void archivesThroughDomainServiceAndReturnsRetentionBoundary() {
        App application = application();
        App archivedApplication = application();
        archivedApplication.setLifecycleStatus("ARCHIVED");
        when(archiveService.archive(
            eq(APPLICATION_ID),
            eq(OWNER_ID),
            eq(PlatformActor.OWNER),
            eq("ARCHIVE_REQUEST"),
            any(String.class)
        )).thenReturn(archivedApplication);

        PlatformApplicationVO result = managementService.archiveApplication(
            APPLICATION_ID,
            user(OWNER_ID, "user")
        );

        assertEquals("ARCHIVED", result.getLifecycleStatus());
        assertEquals("UNAVAILABLE", result.getPublicAvailability());
        assertEquals(true, result.isRetained());
        assertEquals(false, result.isRecoverySupported());
    }

    private App application() {
        App application = new App();
        application.setId(APPLICATION_ID);
        application.setUserId(OWNER_ID);
        application.setAppName("Product");
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        return application;
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(role);
        return user;
    }
}
