package com.zdan.paimengaicodebackend.platform.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationManagementService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import com.zdan.paimengaicodebackend.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class PlatformApplicationControllerTest {

    private static final long APPLICATION_ID = 101L;
    private static final long OWNER_ID = 201L;

    private PlatformApplicationManagementService managementService;
    private UserService userService;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        managementService = org.mockito.Mockito.mock(PlatformApplicationManagementService.class);
        userService = org.mockito.Mockito.mock(UserService.class);
        mockMvc = MockMvcBuilders
            .standaloneSetup(new PlatformApplicationController(managementService, userService))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    @Test
    void ownerCanCreateApplicationAndSubmitRequirement() throws Exception {
        User owner = user(OWNER_ID, "user");
        when(userService.getLoginUser(any())).thenReturn(owner);
        when(managementService.createApplication(eq(owner), eq("Product"))).thenReturn(application());
        when(managementService.submitRequirement(eq(APPLICATION_ID), eq(owner), eq("Build it")))
            .thenReturn(requirement());

        mockMvc
            .perform(
                post("/platform/applications")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"name\":\"Product\"}")
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.lifecycleStatus").value("ACTIVE"));
        mockMvc
            .perform(
                post("/platform/applications/{applicationId}/requirements", APPLICATION_ID)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"originalText\":\"Build it\"}")
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.normalizationStatus").value("PENDING_NORMALIZATION"));
    }

    @Test
    void systemAdministratorCanArchiveApplication() throws Exception {
        User administrator = user(999L, "admin");
        PlatformApplicationVO archived = application();
        archived.setLifecycleStatus("ARCHIVED");
        archived.setPublicAvailability("UNAVAILABLE");
        archived.setRetained(true);
        archived.setRecoverySupported(false);
        when(userService.getLoginUser(any())).thenReturn(administrator);
        when(managementService.archiveApplication(APPLICATION_ID, administrator)).thenReturn(archived);

        mockMvc
            .perform(post("/platform/applications/{applicationId}/archive", APPLICATION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.lifecycleStatus").value("ARCHIVED"))
            .andExpect(jsonPath("$.data.publicAvailability").value("UNAVAILABLE"))
            .andExpect(jsonPath("$.data.retained").value(true))
            .andExpect(jsonPath("$.data.recoverySupported").value(false));
    }

    @Test
    void normalUserIsRejectedFromOtherApplication() throws Exception {
        User normalUser = user(999L, "user");
        when(userService.getLoginUser(any())).thenReturn(normalUser);
        when(managementService.getApplication(APPLICATION_ID, normalUser)).thenThrow(
            new BusinessException(ErrorCode.NO_AUTH_ERROR)
        );

        mockMvc
            .perform(get("/platform/applications/{applicationId}", APPLICATION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(40101));
    }

    @Test
    void publicRequestIsRejectedBeforePlatformManagementService() throws Exception {
        when(userService.getLoginUser(any())).thenThrow(
            new BusinessException(ErrorCode.NOT_LOGIN_ERROR)
        );

        mockMvc
            .perform(get("/platform/applications/{applicationId}", APPLICATION_ID))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(40100));
        verifyNoInteractions(managementService);
    }

    private PlatformApplicationVO application() {
        PlatformApplicationVO application = new PlatformApplicationVO();
        application.setId(APPLICATION_ID);
        application.setOwnerId(OWNER_ID);
        application.setName("Product");
        application.setLifecycleStatus("ACTIVE");
        application.setPublicAvailability("NOT_PROVISIONED");
        application.setRetained(true);
        application.setRecoverySupported(false);
        return application;
    }

    private PlatformRequirementVO requirement() {
        PlatformRequirementVO requirement = new PlatformRequirementVO();
        requirement.setId(301L);
        requirement.setApplicationId(APPLICATION_ID);
        requirement.setOriginalText("Build it");
        requirement.setNormalizationStatus("PENDING_NORMALIZATION");
        return requirement;
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(role);
        return user;
    }
}
