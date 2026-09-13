package com.zdan.paimengaicodebackend.controller;

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

/**
 * GenerationRunController 内部 API 测试（standalone MockMvc，纯单元测试不依赖 Spring 上下文/DB）
 * 验收口径：无/错 Bearer → 401；同 app 并发 run → 409 + 明确文案；合法调用 200。
 *
 * @author LXH
 */
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
        // standalone：注册控制器及其 @ExceptionHandler（401/404/409 映射），不加载全局 Spring 上下文
        mockMvc = MockMvcBuilders.standaloneSetup(new GenerationRunController(generationRunService, properties)).build();
    }

    /**
     * 无 Bearer → 401
     */
    @Test
    void createRunWithoutBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/runs")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 错误 Bearer → 401
     */
    @Test
    void createRunWithWrongBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/runs")
                        .header("Authorization", "Bearer wrong-token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 合法 Bearer 创建 run → 200 + data
     */
    @Test
    void createRunWithValidBearerReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setAppId(1L);
        vo.setPhase("interview");
        when(generationRunService.createRun(any(RunCreateRequest.class))).thenReturn(vo);

        mockMvc.perform(post("/internal/runs")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"runId\":\"run-1\",\"appId\":1,\"userId\":1,\"phase\":\"interview\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.runId").value("run-1"));
    }

    /**
     * 同 app 并发 run → 409 + 明确文案
     */
    @Test
    void createRunConcurrentReturns409WithMessage() throws Exception {
        when(generationRunService.createRun(any(RunCreateRequest.class)))
                .thenThrow(new ConcurrentRunException("当前有进行中的任务"));

        mockMvc.perform(post("/internal/runs")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"runId\":\"run-2\",\"appId\":1,\"userId\":1,\"phase\":\"interview\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.message").value("当前有进行中的任务"));
    }

    /**
     * 更新：run 不存在 → 404
     */
    @Test
    void updateRunNotFoundReturns404() throws Exception {
        when(generationRunService.updateRun(eq("nope"), any()))
                .thenThrow(new BusinessException(ErrorCode.NOT_FOUND_ERROR, "运行不存在"));

        mockMvc.perform(patch("/internal/runs/nope")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phase\":\"coding\"}"))
                .andExpect(status().isNotFound());
    }

    /**
     * 更新：合法更新 → 200
     */
    @Test
    void updateRunReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setPhase("coding");
        when(generationRunService.updateRun(eq("run-1"), any())).thenReturn(vo);

        mockMvc.perform(patch("/internal/runs/run-1")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phase\":\"coding\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.phase").value("coding"));
    }

    /**
     * 查询最新非终态 run：合法调用 → 200
     */
    @Test
    void getLatestNonTerminalRunReturns200() throws Exception {
        RunVO vo = new RunVO();
        vo.setRunId("run-1");
        vo.setPhase("wireframe_pending");
        when(generationRunService.getLatestNonTerminalRun(eq(1L), isNull())).thenReturn(vo);

        mockMvc.perform(get("/internal/apps/1/runs/latest-nonterminal")
                        .header("Authorization", AUTH))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.runId").value("run-1"));
    }

    /**
     * 完成回调：无 Bearer → 401
     */
    @Test
    void completeRunWithoutBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/agent/runs/run-1/complete")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 完成回调：错 Bearer → 401
     */
    @Test
    void completeRunWithWrongBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/agent/runs/run-1/complete")
                        .header("Authorization", "Bearer wrong-token")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 完成回调：合法调用 → 200 true（写历史 + 构建由 service 完成）
     */
    @Test
    void completeRunWithValidBearerReturns200() throws Exception {
        mockMvc.perform(post("/internal/agent/runs/run-1/complete")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"appId\":1,\"userId\":1,\"status\":\"success\",\"workspacePath\":\"/tmp/ws/html_1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data").value(true));
        verify(generationRunService, times(1)).completeRun(eq("run-1"), any());
    }

    /**
     * 完成回调：errorCode 从 HTTP JSON 解析并传入 service
     */
    @Test
    void completeRunForwardsErrorCodeFromJson() throws Exception {
        mockMvc.perform(post("/internal/agent/runs/run-1/complete")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"appId\":1,\"userId\":1,\"status\":\"failed\",\"errorCode\":\"model-error\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        ArgumentCaptor<AgentCompleteRequest> requestCaptor = ArgumentCaptor.forClass(AgentCompleteRequest.class);
        verify(generationRunService).completeRun(eq("run-1"), requestCaptor.capture());
        assertEquals("model-error", requestCaptor.getValue().getErrorCode());
    }


    @Test
    void completeRunInvalidParamReturns400() throws Exception {
        doThrow(new BusinessException(ErrorCode.PARAMS_ERROR, "status 仅接受 success/failed"))
                .when(generationRunService).completeRun(eq("run-1"), any());

        mockMvc.perform(post("/internal/agent/runs/run-1/complete")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"appId\":1,\"userId\":1,\"status\":\"unknown\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("status 仅接受 success/failed"));
    }

    /**
     * 线框配额：无 Bearer → 401
     */
    @Test
    void acquireWireframeQuotaWithoutBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/agent/wireframe/quota/acquire")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":1}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 线框配额：合法调用 → 200 true
     */
    @Test
    void acquireWireframeQuotaWithValidBearerReturns200() throws Exception {
        when(generationRunService.acquireWireframeDailyQuota(1L)).thenReturn(true);

        mockMvc.perform(post("/internal/agent/wireframe/quota/acquire")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data").value(true));
    }

    /**
     * 线框配额：每日次数用完（service 抛 TOO_MANY_REQUEST）→ 429 明确文案
     */
    @Test
    void acquireWireframeQuotaExceededReturns429() throws Exception {
        doThrow(new BusinessException(ErrorCode.TOO_MANY_REQUEST, "今日线框生成次数已用完，请明天再试"))
                .when(generationRunService).acquireWireframeDailyQuota(1L);

        mockMvc.perform(post("/internal/agent/wireframe/quota/acquire")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"userId\":1}"))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.message").value("今日线框生成次数已用完，请明天再试"));
    }

    /**
     * 冻结积分：无 Bearer → 401
     */
    @Test
    void freezeCreditWithoutBearerReturns401() throws Exception {
        mockMvc.perform(post("/internal/agent/runs/run-1/credit/freeze")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"intensity\":\"standard\"}"))
                .andExpect(status().isUnauthorized());
    }

    /**
     * 冻结积分：合法调用 → 200 + 冻结结果
     */
    @Test
    void freezeCreditWithValidBearerReturns200() throws Exception {
        CreditFreezeVO vo = new CreditFreezeVO();
        vo.setLedgerId(9L);
        vo.setFrozenAmount(100);
        vo.setBalance(400);
        when(generationRunService.freezeCredit(eq("run-1"), any())).thenReturn(vo);

        mockMvc.perform(post("/internal/agent/runs/run-1/credit/freeze")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"intensity\":\"standard\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.ledgerId").value(9))
                .andExpect(jsonPath("$.data.frozenAmount").value(100))
                .andExpect(jsonPath("$.data.balance").value(400));
    }

    /**
     * 冻结积分：余额不足（service 抛 CREDIT_NOT_ENOUGH）→ 402 + 明确文案（TS Agent 映射 error 事件）
     */
    @Test
    void freezeCreditInsufficientBalanceReturns402() throws Exception {
        doThrow(new BusinessException(ErrorCode.CREDIT_NOT_ENOUGH, "积分不足，当前余额 50，本次生成需 100 积分，请先充值"))
                .when(generationRunService).freezeCredit(eq("run-1"), any());

        mockMvc.perform(post("/internal/agent/runs/run-1/credit/freeze")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"intensity\":\"standard\"}"))
                .andExpect(status().isPaymentRequired())
                .andExpect(jsonPath("$.message").value("积分不足，当前余额 50，本次生成需 100 积分，请先充值"));
    }

    /**
     * 冻结积分：未确认线框（service 抛 FORBIDDEN）→ 403
     */
    @Test
    void freezeCreditNonConfirmedPhaseReturns403() throws Exception {
        doThrow(new BusinessException(ErrorCode.FORBIDDEN_ERROR, "当前阶段（wireframe_pending）不能冻结积分，请先确认线框"))
                .when(generationRunService).freezeCredit(eq("run-1"), any());

        mockMvc.perform(post("/internal/agent/runs/run-1/credit/freeze")
                        .header("Authorization", AUTH)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"intensity\":\"standard\"}"))
                .andExpect(status().isForbidden());
    }
}
