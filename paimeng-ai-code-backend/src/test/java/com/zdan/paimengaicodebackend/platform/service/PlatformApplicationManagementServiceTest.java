package com.zdan.paimengaicodebackend.platform.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationArchiveService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplication;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
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
    private PlatformApplicationMapper applicationMapper;

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
            applicationMapper,
            requirementMapper,
            relationValidator,
            archiveService
        );
    }

    @Test
    void ownerCreatesApplicationForSelf() {
        User owner = user(OWNER_ID, "user");

        PlatformApplicationVO result = managementService.createApplication(owner, "  Product  ");

        ArgumentCaptor<PlatformApplication> applicationCaptor = ArgumentCaptor.forClass(
            PlatformApplication.class
        );
        verify(applicationMapper).insertSelective(applicationCaptor.capture());
        assertEquals(OWNER_ID, applicationCaptor.getValue().getOwnerId());
        assertEquals("Product", applicationCaptor.getValue().getName());
        assertEquals("ACTIVE", result.getLifecycleStatus());
    }

    @Test
    void ownerSubmitsUnchangedRequirementWithPendingNormalizationStatus() {
        PlatformApplication application = application();
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
        PlatformApplication application = application();
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
        PlatformApplication application = application();
        application.setIsDeleted(1);
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

    private PlatformApplication application() {
        PlatformApplication application = new PlatformApplication();
        application.setId(APPLICATION_ID);
        application.setOwnerId(OWNER_ID);
        application.setName("Product");
        application.setIsDeleted(0);
        return application;
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(role);
        return user;
    }
}
