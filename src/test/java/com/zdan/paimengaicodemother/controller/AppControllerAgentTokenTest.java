package com.zdan.paimengaicodemother.controller;

import cn.hutool.jwt.JWT;
import cn.hutool.jwt.JWTUtil;
import cn.hutool.json.JSONObject;
import cn.hutool.json.JSONUtil;
import com.zdan.paimengaicodemother.ai.agent.AgentJwtProperties;
import com.zdan.paimengaicodemother.ai.agent.AgentJwtService;
import com.zdan.paimengaicodemother.ai.agent.AgentProperties;
import com.zdan.paimengaicodemother.ai.agent.RunIdSinkRegistry;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodemother.model.entity.App;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.AppService;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.service.ProjectDownloadService;
import com.zdan.paimengaicodemother.service.UserService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * AppController Agent 直连令牌端点测试（standalone MockMvc，纯单元测试不依赖 Spring 上下文/DB）
 * 验收口径：未登录 → 40100；应用不存在 → 40400；非归属用户 → 40101；归属用户 → 200 且令牌可验签、路径对齐旧链路
 *
 * @author LXH
 */
class AppControllerAgentTokenTest {

    private static final String SECRET = "test-shared-secret";
    private static final byte[] SECRET_BYTES = SECRET.getBytes(StandardCharsets.UTF_8);

    private static final long APP_ID = 903L;
    private static final long OWNER_ID = 101L;

    private AppService appService;
    private UserService userService;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        appService = mock(AppService.class);
        userService = mock(UserService.class);
        AgentJwtProperties jwtProperties = new AgentJwtProperties();
        jwtProperties.setSecret(SECRET);
        AppController controller = new AppController(appService, userService,
                mock(ProjectDownloadService.class), mock(AgentProperties.class),
                jwtProperties, new AgentJwtService(jwtProperties),
                mock(RunIdSinkRegistry.class), mock(ChatHistoryService.class));
        // standalone：注册全局异常处理器（BusinessException → 标准 JSON 错误码）
        mockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    /**
     * 构造归属明确的用户与应用
     */
    private App mockOwnedApp(Long ownerId) {
        User loginUser = new User();
        loginUser.setId(OWNER_ID);
        when(userService.getLoginUser(org.mockito.ArgumentMatchers.any())).thenReturn(loginUser);
        App app = new App();
        app.setId(APP_ID);
        app.setUserId(ownerId);
        app.setCodeGenType("html");
        when(appService.getById(APP_ID)).thenReturn(app);
        return app;
    }

    /**
     * 未登录 → 40100
     */
    @Test
    void notLoginReturns40100() throws Exception {
        when(userService.getLoginUser(org.mockito.ArgumentMatchers.any()))
                .thenThrow(new BusinessException(ErrorCode.NOT_LOGIN_ERROR));
        mockMvc.perform(get("/app/agent/token").param("appId", String.valueOf(APP_ID)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(40100));
    }

    /**
     * 应用不存在 → 40400
     */
    @Test
    void appNotFoundReturns40400() throws Exception {
        User loginUser = new User();
        loginUser.setId(OWNER_ID);
        when(userService.getLoginUser(org.mockito.ArgumentMatchers.any())).thenReturn(loginUser);
        when(appService.getById(APP_ID)).thenReturn(null);
        mockMvc.perform(get("/app/agent/token").param("appId", String.valueOf(APP_ID)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(40400));
    }

    /**
     * 非应用归属者 → 40101 无权限
     */
    @Test
    void notOwnerReturns40101() throws Exception {
        mockOwnedApp(999L);
        mockMvc.perform(get("/app/agent/token").param("appId", String.valueOf(APP_ID)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(40101));
    }

    /**
     * 归属用户 → 200：令牌可验签、sub 为字符串用户 id、workspacePath 与旧链路命名一致
     */
    @Test
    void ownerReceivesVerifiableToken() throws Exception {
        mockOwnedApp(OWNER_ID);
        MvcResult result = mockMvc.perform(get("/app/agent/token").param("appId", String.valueOf(APP_ID)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.workspacePath").isNotEmpty())
                .andReturn();
        JSONObject body = JSONUtil.parseObj(result.getResponse().getContentAsString());
        JSONObject data = body.getJSONObject("data");
        String token = data.getStr("token");
        assertTrue(JWTUtil.verify(token, SECRET_BYTES));
        assertEquals(String.valueOf(OWNER_ID), JWT.of(token).getPayload("sub"));
        assertTrue(data.getStr("workspacePath").endsWith("tmp/code_output/html_" + APP_ID));
        assertTrue(data.getLong("expiresAt") > System.currentTimeMillis());
    }
}
