package com.zdan.paimengaicodebackend.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.zdan.paimengaicodebackend.config.InternalApiProperties;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ConcurrentRunException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;
import com.zdan.paimengaicodebackend.service.GenerationRunService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class GenerationRunControllerTest {

    private static final String TOKEN = "test-token";
    private static final String AUTH = "Bearer " + TOKEN;

    private GenerationRunService generationRunService;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        generationRunService = mock(GenerationRunService.class);
        InternalApiProperties properties = new InternalApiProperties();
        properties.setToken(TOKEN);

        mockMvc = MockMvcBuilders.standaloneSetup(
            new GenerationRunController(generationRunService, properties)
        ).build();
    }

    @Test
    void createRunWithoutBearerReturns401() throws Exception {
        mockMvc
            .perform(post("/internal/runs").contentType(MediaType.APPLICATION_JSON).content("{}"))
            .andExpect(status().isUnauthorized());
    }

    @Test
    void createRunWithWrongBearerReturns401() throws Exception {
        mockMvc
            .perform(
                post("/internal/runs")
                    .header("Authorization", "Bearer wrong-token")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{}")
            )
            .andExpect(status().isUnauthorized());
    }

    @Test
    void createRunWithValidBearerReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setAppId(1L);
        vo.setPhase("interview");
        when(generationRunService.createRun(any(RunCreateRequest.class))).thenReturn(vo);

        mockMvc
            .perform(
                post("/internal/runs")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"runId\":\"run-1\",\"appId\":1,\"userId\":1,\"phase\":\"interview\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.runId").value("run-1"));
    }

    @Test
    void createRunConcurrentReturns409WithMessage() throws Exception {
        when(generationRunService.createRun(any(RunCreateRequest.class))).thenThrow(
            new ConcurrentRunException("当前有进行中的任务")
        );

        mockMvc
            .perform(
                post("/internal/runs")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"runId\":\"run-2\",\"appId\":1,\"userId\":1,\"phase\":\"interview\"}"
                    )
            )
            .andExpect(status().isConflict())
            .andExpect(jsonPath("$.message").value("当前有进行中的任务"));
    }

    @Test
    void updateRunNotFoundReturns404() throws Exception {
        when(generationRunService.updateRun(eq("nope"), any())).thenThrow(
            new BusinessException(ErrorCode.NOT_FOUND_ERROR, "运行不存在")
        );

        mockMvc
            .perform(
                patch("/internal/runs/nope")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"phase\":\"coding\"}")
            )
            .andExpect(status().isNotFound());
    }

    @Test
    void updateRunReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setPhase("coding");
        when(generationRunService.updateRun(eq("run-1"), any())).thenReturn(vo);

        mockMvc
            .perform(
                patch("/internal/runs/run-1")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"phase\":\"coding\"}")
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.phase").value("coding"));
    }

    @Test
    void getLatestNonTerminalRunReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setPhase("wireframe_pending");
        when(generationRunService.getLatestNonTerminalRun(eq(1L), isNull())).thenReturn(vo);

        mockMvc
            .perform(get("/internal/apps/1/runs/latest-nonterminal").header("Authorization", AUTH))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.data.runId").value("run-1"));
    }

    @Test
    void completeRunWithoutBearerReturns401() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/complete")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{}")
            )
            .andExpect(status().isUnauthorized());
    }

    @Test
    void completeRunWithWrongBearerReturns401() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/complete")
                    .header("Authorization", "Bearer wrong-token")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{}")
            )
            .andExpect(status().isUnauthorized());
    }

    @Test
    void completeRunWithValidBearerReturns200() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/complete")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"appId\":1,\"userId\":1,\"status\":\"success\",\"workspacePath\":\"/tmp/ws/html_1\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data").value(true));
        verify(generationRunService, times(1)).completeRun(eq("run-1"), any());
    }

    @Test
    void completeRunForwardsErrorCodeFromJson() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/complete")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"appId\":1,\"userId\":1,\"status\":\"failed\",\"errorCode\":\"model-error\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0));

        ArgumentCaptor<AgentCompleteRequest> requestCaptor = ArgumentCaptor.forClass(
            AgentCompleteRequest.class
        );
        verify(generationRunService).completeRun(eq("run-1"), requestCaptor.capture());
        assertEquals("model-error", requestCaptor.getValue().getErrorCode());
    }

    @Test
    void completeRunInvalidParamReturns400() throws Exception {
        doThrow(new BusinessException(ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed"))
            .when(generationRunService)
            .completeRun(eq("run-1"), any());

        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/complete")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"appId\":1,\"userId\":1,\"status\":\"unknown\"}")
            )
            .andExpect(status().isBadRequest())
            .andExpect(jsonPath("$.message").value("status 仅接受 success/failed"));
    }

    @Test
    void acquireWireframeQuotaWithoutBearerReturns401() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/wireframe/quota/acquire")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"userId\":1}")
            )
            .andExpect(status().isUnauthorized());
    }

    @Test
    void acquireWireframeQuotaWithValidBearerReturns200() throws Exception {
        when(generationRunService.acquireWireframeDailyQuota(1L)).thenReturn(true);

        mockMvc
            .perform(
                post("/internal/agent/wireframe/quota/acquire")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"userId\":1}")
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data").value(true));
    }

    @Test
    void acquireWireframeQuotaExceededReturns429() throws Exception {
        doThrow(
            new BusinessException(ErrorCode.TOO_MANY_REQUEST, "今日线框生成次数已用完，请明天再试")
        )
            .when(generationRunService)
            .acquireWireframeDailyQuota(1L);

        mockMvc
            .perform(
                post("/internal/agent/wireframe/quota/acquire")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"userId\":1}")
            )
            .andExpect(status().isTooManyRequests())
            .andExpect(jsonPath("$.message").value("今日线框生成次数已用完，请明天再试"));
    }

    @Test
    void freezeCreditWithoutBearerReturns401() throws Exception {
        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/credit/freeze")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"intensity\":\"standard\"}")
            )
            .andExpect(status().isUnauthorized());
    }

    @Test
    void freezeCreditWithValidBearerReturns200() throws Exception {
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(9L);
        vo.setFrozenAmount(100);
        vo.setBalance(400);
        when(generationRunService.freezeCredit(eq("run-1"), any())).thenReturn(vo);

        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/credit/freeze")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"intensity\":\"standard\"}")
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.ledgerId").value(9))
            .andExpect(jsonPath("$.data.frozenAmount").value(100))
            .andExpect(jsonPath("$.data.balance").value(400));
    }

    @Test
    void freezeCreditInsufficientBalanceReturns402() throws Exception {
        doThrow(
            new BusinessException(
                ErrorCode.CREDIT_NOT_ENOUGH,
                "积分不足，当前余额 50，本次生成需 100 积分，请先充值"
            )
        )
            .when(generationRunService)
            .freezeCredit(eq("run-1"), any());

        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/credit/freeze")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"intensity\":\"standard\"}")
            )
            .andExpect(status().isPaymentRequired())
            .andExpect(
                jsonPath("$.message").value("积分不足，当前余额 50，本次生成需 100 积分，请先充值")
            );
    }

    @Test
    void freezeCreditNonConfirmedPhaseReturns403() throws Exception {
        doThrow(
            new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "当前阶段（wireframe_pending）不能冻结积分，请先确认线框"
            )
        )
            .when(generationRunService)
            .freezeCredit(eq("run-1"), any());

        mockMvc
            .perform(
                post("/internal/agent/runs/run-1/credit/freeze")
                    .header("Authorization", AUTH)
                    .contentType(MediaType.APPLICATION_JSON)
                    .content("{\"intensity\":\"standard\"}")
            )
            .andExpect(status().isForbidden());
    }
}
