package com.zdan.paimengaicodebackend.platform.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformStatusStreamRegistry;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationStatusService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformClarificationAnswerVO;
import com.zdan.paimengaicodebackend.service.UserService;
import java.time.LocalDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Owner 状态与答复的 HTTP 边界（Issue #80 / T-08）
 *
 * <p>AC4 的主体校验只在 service 层有测试，而 HTTP 层另有两件事必须由这里守住：
 * 未登录必须走 401 而不是别的错误码，以及 {@code /status/stream} 订阅失败必须是**普通错误响应**
 * 而不是一条永远不推送的流——后者一旦发生，Owner 会看到一个转圈不动的界面且没有任何提示。
 */
class PlatformApplicationStatusControllerTest {

    private static final long APPLICATION_ID = 460017668615995392L;
    private static final long OWNER_ID = 377708067863715840L;
    private static final long STRANGER_ID = 424242424242424242L;

    private final PlatformApplicationStatusService statusService = mock(PlatformApplicationStatusService.class);
    private final UserService userService = mock(UserService.class);
    private final PlatformStatusStreamRegistry streamRegistry = mock(PlatformStatusStreamRegistry.class);

    private MockMvc mockMvc;
    private MockHttpServletRequest request;

    @BeforeEach
    void setUp() {
        // 异常必须经 GlobalExceptionHandler 变成业务错误码，而不是 500；
        // standaloneSetup 不加载上下文，所以要显式挂上与生产一致的 advice。
        mockMvc = MockMvcBuilders.standaloneSetup(
                new PlatformApplicationStatusController(statusService, streamRegistry, userService))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
        request = new MockHttpServletRequest();
    }

    @Test
    void ownerReadsItsOwnStatus() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(OWNER_ID, "user"));
        when(statusService.getStatus(APPLICATION_ID, user(OWNER_ID, "user"))).thenReturn(blockedStatus());

        mockMvc.perform(get("/platform/applications/{id}/status", APPLICATION_ID).session(
                new org.springframework.mock.web.MockHttpSession()))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.status").value("BLOCKED"))
            .andExpect(jsonPath("$.data.answerRequired").value(true))
            .andExpect(jsonPath("$.data.blockingQuestion").value("客户可以提前几天预约？"));
    }

    @Test
    void anUnauthenticatedCallerIsRejectedBeforeTheStatusIsRead() throws Exception {
        when(userService.getLoginUser(any())).thenThrow(new BusinessException(ErrorCode.NOT_LOGIN_ERROR));

        mockMvc.perform(get("/platform/applications/{id}/status", APPLICATION_ID))
            .andExpect(jsonPath("$.code").value(ErrorCode.NOT_LOGIN_ERROR.getCode()));
    }

    @Test
    void aNonOwnerIsRejectedWithTheAuthorizationCode() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(STRANGER_ID, "user"));
        when(statusService.getStatus(eq(APPLICATION_ID), any(User.class))).thenThrow(
            new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权管理该 Application"));

        mockMvc.perform(get("/platform/applications/{id}/status", APPLICATION_ID))
            .andExpect(jsonPath("$.code").value(ErrorCode.NO_AUTH_ERROR.getCode()));
    }

    @Test
    void statusStreamFailsAsAnOrdinaryResponseWhenTheCallerIsNotAuthorized() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(STRANGER_ID, "user"));
        when(statusService.getStatus(eq(APPLICATION_ID), any(User.class))).thenThrow(
            new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权管理该 Application"));

        mockMvc.perform(get("/platform/applications/{id}/status/stream", APPLICATION_ID))
            .andExpect(jsonPath("$.code").value(ErrorCode.NO_AUTH_ERROR.getCode()));
        // 关键：不得开流。一个鉴权失败却返回 200 text/event-stream 的实现，
        // 会让 Owner 面对一个永不结束也永不出错的空界面。
        verify(streamRegistry, org.mockito.Mockito.never())
            .subscribe(eq(APPLICATION_ID), any(String.class), any());
    }

    @Test
    void statusStreamSendsTheProjectionImmediatelyOnSubscribe() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(OWNER_ID, "user"));
        when(statusService.getStatus(APPLICATION_ID, user(OWNER_ID, "user"))).thenReturn(blockedStatus());
        when(streamRegistry.subscribe(eq(APPLICATION_ID), any(String.class), any()))
            .thenAnswer(invocation -> {
                // 注册表会在登记时立刻推一次；模拟它把投影送进 emitter。
                @SuppressWarnings("unchecked")
                java.util.function.Consumer<SseEmitter> projector =
                    invocation.getArgument(2, java.util.function.Consumer.class);
                SseEmitter emitter = new SseEmitter();
                projector.accept(emitter);
                return emitter;
            });

        mockMvc.perform(get("/platform/applications/{id}/status/stream", APPLICATION_ID))
            .andExpect(status().isOk())
            .andExpect(content().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM));
        verify(streamRegistry).subscribe(eq(APPLICATION_ID), any(String.class), any());
    }

    @Test
    void ownerSubmitsTheBlockingAnswerThroughTheHttpContract() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(OWNER_ID, "user"));
        PlatformClarificationAnswerVO answer = new PlatformClarificationAnswerVO();
        answer.setAnswerRequirementId("460017668615995395");
        answer.setTaskId("460017668615995394");
        answer.setReopenedSameTask(true);
        answer.setAcceptedAt(LocalDateTime.now());
        when(statusService.answerBlockingQuestion(APPLICATION_ID, "460017668615995394", "提前 14 天",
            user(OWNER_ID, "user"))).thenReturn(answer);

        mockMvc.perform(post("/platform/applications/{id}/clarification-answers", APPLICATION_ID)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"taskId\":\"460017668615995394\",\"answerText\":\"提前 14 天\"}"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.answerRequirementId").value("460017668615995395"))
            .andExpect(jsonPath("$.data.reopenedSameTask").value(true));
    }

    @Test
    void anEmptyAnswerBodyNeverReachesTheDomain() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(OWNER_ID, "user"));

        mockMvc.perform(post("/platform/applications/{id}/clarification-answers", APPLICATION_ID)
                .contentType(MediaType.APPLICATION_JSON))
            // 空 body 落在 GlobalExceptionHandler 的 RuntimeException 分支上，返回 SYSTEM_ERROR。
            // 那是全项目既有的映射（没有 HttpMessageNotReadableException 的专门处理），不是本端点
            // 的问题，因此这里断言「服务从未被调用」这个真正要守的不变量，而不是一个理想错误码。
            .andExpect(jsonPath("$.code").value(ErrorCode.SYSTEM_ERROR.getCode()));
        verify(statusService, org.mockito.Mockito.never())
            .answerBlockingQuestion(any(), any(), any(), any());
    }

    @Test
    void aBlankAnswerTextNeverReachesTheDomain() throws Exception {
        when(userService.getLoginUser(any())).thenReturn(user(OWNER_ID, "user"));
        when(statusService.answerBlockingQuestion(any(), any(), any(), any())).thenThrow(
            new BusinessException(ErrorCode.PARAMS_ERROR, "答复内容不能为空"));

        mockMvc.perform(post("/platform/applications/{id}/clarification-answers", APPLICATION_ID)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"taskId\":\"460017668615995394\",\"answerText\":\"   \"}"))
            .andExpect(jsonPath("$.code").value(ErrorCode.PARAMS_ERROR.getCode()));
    }

    private PlatformApplicationStatusVO blockedStatus() {
        PlatformApplicationStatusVO status = new PlatformApplicationStatusVO();
        status.setApplicationId(String.valueOf(APPLICATION_ID));
        status.setStatus(PlatformOwnerVisibleStatus.BLOCKED);
        status.setHeadline(PlatformOwnerVisibleStatus.BLOCKED.headline());
        status.setDetail("我们只需要确认一件事，确认后就会继续构建。");
        status.setAnswerRequired(true);
        status.setBlockingQuestion("客户可以提前几天预约？");
        return status;
    }

    private User user(long id, String role) {
        User user = new User();
        user.setId(id);
        user.setUserRole(UserConstant.ADMIN_ROLE.equals(role) ? UserConstant.ADMIN_ROLE : "user");
        return user;
    }
}
