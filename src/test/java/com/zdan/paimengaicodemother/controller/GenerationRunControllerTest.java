package com.zdan.paimengaicodemother.controller;

import com.zdan.paimengaicodemother.config.InternalApiProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.GenerationRunService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
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
}
