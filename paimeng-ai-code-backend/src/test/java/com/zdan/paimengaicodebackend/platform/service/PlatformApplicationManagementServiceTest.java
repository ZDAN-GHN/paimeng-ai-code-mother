package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationArchiveService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
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

    private static final long APPLICATION_ID = 101L;
    private static final long OWNER_ID = 201L;

    @Mock
    private AppMapper appMapper;

    @Mock
    private PlatformRequirementMapper requirementMapper;

    @Mock
    private PlatformLogicalRelationValidator relationValidator;

    @Mock
    private PlatformApplicationArchiveService archiveService;

    private PlatformApplicationManagementService managementService;

    @BeforeEach
    void setUp() {
        managementService = new PlatformApplicationManagementService(
            appMapper,
            requirementMapper,
            relationValidator,
            archiveService
        );
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
        when(relationValidator.requireActiveApplication(APPLICATION_ID)).thenReturn(application);
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
        when(relationValidator.requireActiveApplication(APPLICATION_ID)).thenReturn(application());

        PlatformApplicationInitialRequirementVO result = managementService.createApplicationWithInitialRequirement(
            owner,
            "Product",
            "Build it"
        );

        verify(appMapper).insertSelective(any(App.class));
        verify(requirementMapper).insertSelective(any(PlatformRequirement.class));
        assertEquals(APPLICATION_ID, result.getApplication().getId());
        assertEquals("Build it", result.getRequirement().getOriginalText());
        assertEquals("PENDING_NORMALIZATION", result.getRequirement().getNormalizationStatus());
    }

    @Test
    void ownerListsOnlyActiveApplicationsTheyCreated() {
        Page<App> applications = new Page<>(1, 12, 1);
        applications.setRecords(List.of(application()));
        when(appMapper.paginate(any(Page.class), any())).thenReturn(applications);

        Page<PlatformApplicationVO> result = managementService.listMyApplications(
            user(OWNER_ID, "user"),
            1,
            12
        );

        assertEquals(1, result.getRecords().size());
        assertEquals(APPLICATION_ID, result.getRecords().getFirst().getId());
    }

    @Test
    void ownerListsRequirementHistoryForTheirApplication() {
        Page<PlatformRequirement> requirements = new Page<>(1, 20, 1);
        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setId(301L);
        requirement.setApplicationId(APPLICATION_ID);
        requirement.setOriginalText("Build it");
        requirements.setRecords(List.of(requirement));
        when(relationValidator.requireActiveApplication(APPLICATION_ID)).thenReturn(application());
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
    void rejectsNonOwnerButAllowsSystemAdministratorToRead() {
        App application = application();
        when(relationValidator.requireActiveApplication(APPLICATION_ID)).thenReturn(application);

        assertThrows(
            BusinessException.class,
            () -> managementService.getApplication(APPLICATION_ID, user(999L, "user"))
        );

        PlatformApplicationVO result = managementService.getApplication(
            APPLICATION_ID,
            user(999L, "admin")
        );
        assertEquals(APPLICATION_ID, result.getId());
    }

    @Test
    void archivesThroughDomainServiceAndReturnsRetentionBoundary() {
        App application = application();
        application.setLifecycleStatus("ARCHIVED");
        when(relationValidator.requireActiveApplication(APPLICATION_ID)).thenReturn(application);
        when(archiveService.archive(
            eq(APPLICATION_ID),
            eq(OWNER_ID),
            eq(PlatformActor.OWNER),
            eq("ARCHIVE_REQUEST"),
            any(String.class)
        )).thenReturn(application);

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
