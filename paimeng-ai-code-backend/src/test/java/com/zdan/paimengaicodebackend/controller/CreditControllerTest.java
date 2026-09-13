package com.zdan.paimengaicodebackend.controller;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodebackend.model.dto.user.CreditRechargeRequest;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.service.CreditService;
import com.zdan.paimengaicodebackend.service.UserService;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * CreditController 测试（standalone MockMvc，纯单元测试不依赖 Spring 上下文/DB）
 * 覆盖：管理员充值（成功/非法参数）、当前登录用户余额查询（成功/未登录）。
 * 注：@AuthCheck(ADMIN_ROLE) 由 AuthInterceptor 拦截器实现，standalone 不装配，此处仅验证端点行为。
 *
 * @author LXH
 */
class CreditControllerTest {

    private CreditService creditService;
    private UserService userService;
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        creditService = mock(CreditService.class);
        userService = mock(UserService.class);
        mockMvc = MockMvcBuilders.standaloneSetup(new CreditController(creditService, userService))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    private CreditRechargeRequest rechargeRequest(long userId, int credits) {
        CreditRechargeRequest request = new CreditRechargeRequest();
        request.setUserId(userId);
        request.setCredits(credits);
        return request;
    }

    /**
     * 管理员充值成功 → 200 true
     */
    @Test
    void rechargeReturns200() throws Exception {
        mockMvc.perform(post("/credit/recharge")
                        .contentType("application/json")
                        .content("{\"userId\":1,\"credits\":200}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data").value(true));
        org.mockito.Mockito.verify(creditService).recharge(1L, 200);
    }

    /**
     * 充值非正积分数（service 抛 PARAMS_ERROR）→ 全局异常处理
     */
    @Test
    void rechargeInvalidCreditsReturnsError() throws Exception {
        org.mockito.Mockito.doThrow(new BusinessException(ErrorCode.PARAMS_ERROR, "充值积分数必须为正数"))
                .when(creditService).recharge(1L, -10);

        mockMvc.perform(post("/credit/recharge")
                        .contentType("application/json")
                        .content("{\"userId\":1,\"credits\":-10}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(ErrorCode.PARAMS_ERROR.getCode()));
    }

    /**
     * 当前登录用户余额查询 → 200 balance
     */
    @Test
    void getBalanceReturns200() throws Exception {
        User user = new User();
        user.setId(1L);
        when(userService.getLoginUser(any(HttpServletRequest.class))).thenReturn(user);
        when(creditService.getBalance(1L)).thenReturn(320);

        mockMvc.perform(get("/credit/balance"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data").value(320));
    }

    /**
     * 余额查询未登录（service 抛 NOT_LOGIN）→ 40100
     */
    @Test
    void getBalanceWithoutLoginReturnsNotLogin() throws Exception {
        when(userService.getLoginUser(any(HttpServletRequest.class)))
                .thenThrow(new BusinessException(ErrorCode.NOT_LOGIN_ERROR, "未登录"));

        mockMvc.perform(get("/credit/balance"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(ErrorCode.NOT_LOGIN_ERROR.getCode()));
    }
}
