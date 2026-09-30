package com.zdan.paimengaicodebackend.platform.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zdan.paimengaicodebackend.exception.GlobalExceptionHandler;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLoopbackCallerGuard;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunBlockRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformRunExecutionService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformExecutionCapabilitiesVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunCommandResultVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseGrantVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseVO;
import java.time.LocalDateTime;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.RequestPostProcessor;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * 受控执行端点的 HTTP 契约与围栏（Issue #77 / T-05，计划步骤 29）。
 *
 * <p>这里只断言控制器自己负责的事：回环围栏、请求到服务参数的映射、Long ID 的十进制字符串
 * 传输、以及异常经 {@code GlobalExceptionHandler} 变成业务错误码而非 500。编排顺序与
 * Lease 判据由 {@code PlatformRunExecutionServiceTest} 覆盖。
 *
 * <p><strong>边界</strong>：{@code standaloneSetup} 不加载 Spring 上下文，用的是默认
 * ObjectMapper，因此观察不到 {@code JsonConfig} 的全局 {@code long → String} 规则。
 * 数值字段的线上形态<strong>不能</strong>在本类断言（会因错误的原因通过），
 * 由 {@code PlatformExecutionWireFormatTest} 负责。本类只断言显式声明为 {@code String}
 * 的字段，它们在两种 ObjectMapper 下结果一致。
 */
class PlatformRunExecutionControllerTest {

    private static final String APPLICATION_ID = "460017668615995392";
    private static final String RUN_ID = "run-7001";
    private static final long FENCE_TOKEN = 3L;

    private PlatformRunExecutionService executionService;
    private final ObjectMapper mapper = new ObjectMapper();

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        executionService = mock(PlatformRunExecutionService.class);
        mockMvc = MockMvcBuilders
            .standaloneSetup(new PlatformRunExecutionController(executionService, new PlatformLoopbackCallerGuard()))
            .setControllerAdvice(new GlobalExceptionHandler())
            .build();
    }

    @Test
    void loopbackCallerCanGrantLeaseAndReadRealCapabilities() throws Exception {
        when(executionService.grantLease(eq(APPLICATION_ID), eq(RUN_ID), eq("RUN_STARTED"), eq("req-1"), eq(1)))
            .thenReturn(grant());

        mockMvc
            .perform(
                post("/platform/runs/execution/lease")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"reasonCode\":\"RUN_STARTED\",\"requestId\":\"req-1\","
                            + "\"recoveryProtocolVersion\":1}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.lease.applicationId").value(APPLICATION_ID))
            .andExpect(jsonPath("$.data.lease.taskId").value("9001"))
            .andExpect(jsonPath("$.data.baselineJson").value("{\"schemaVersion\":1}"))
            .andExpect(jsonPath("$.data.capabilities.schemaVersion").value("1"))
            .andExpect(jsonPath("$.data.capabilities.networkAccessAvailable").value(false))
            .andExpect(jsonPath("$.data.capabilities.workspacePersistent").value(false));
    }

    @Test
    void nonLoopbackCallerIsRejectedBeforeReachingService() throws Exception {
        mockMvc
            .perform(
                post("/platform/runs/execution/lease")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"reasonCode\":\"RUN_STARTED\",\"requestId\":\"req-1\"}"
                    )
                    .with(remoteAddress("10.11.12.13"))
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(ErrorCode.FORBIDDEN_ERROR.getCode()));
        verifyNoInteractions(executionService);
    }

    @Test
    void everyEndpointRefusesNonLoopbackCaller() throws Exception {
        String body = "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
            + "\",\"fenceToken\":" + FENCE_TOKEN + ",\"requestId\":\"req-1\"}";
        String[] postPaths = {
            "/platform/runs/execution/lease",
            "/platform/runs/execution/lease/renew",
            "/platform/runs/execution/lease/release",
            "/platform/runs/execution/recovery/prepare",
            "/platform/runs/execution/recovery/begin",
            "/platform/runs/execution/commands",
            "/platform/runs/execution/results"
        };

        for (String path : postPaths) {
            mockMvc
                .perform(
                    post(path)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body)
                        .with(remoteAddress("172.20.0.9"))
                )
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(ErrorCode.FORBIDDEN_ERROR.getCode()));
        }
        mockMvc
            .perform(get("/platform/runs/execution/capabilities").with(remoteAddress("172.20.0.9")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(ErrorCode.FORBIDDEN_ERROR.getCode()));
        verifyNoInteractions(executionService);
    }

    @Test
    void loopbackRecoveryRequestsCarryTheFenceAndRequestKey() throws Exception {
        String body = "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
            + "\",\"fenceToken\":" + FENCE_TOKEN + ",\"requestId\":\"prepare-1\"}";
        mockMvc.perform(post("/platform/runs/execution/recovery/prepare")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0));
        verify(executionService).prepareRecovery(APPLICATION_ID, RUN_ID, FENCE_TOKEN, "prepare-1");

        mockMvc.perform(post("/platform/runs/execution/recovery/begin")
                .contentType(MediaType.APPLICATION_JSON).content(body))
            .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0));
        verify(executionService).beginExecution(APPLICATION_ID, RUN_ID, FENCE_TOKEN, "prepare-1");
    }

    @Test
    void ipv6LoopbackIsAcceptedAsLocalCaller() throws Exception {
        when(executionService.buildCapabilities()).thenReturn(capabilities());

        mockMvc
            .perform(get("/platform/runs/execution/capabilities").with(remoteAddress("::1")))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.schemaVersion").value("1"));
    }

    @Test
    void staleFenceTokenSurfacesAsBusinessErrorCodeNotServerError() throws Exception {
        when(executionService.execute(any(), any(), any(), any(), any(), any())).thenThrow(
            new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Lease fence token 已过期")
        );

        mockMvc
            .perform(
                post("/platform/runs/execution/commands")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"fenceToken\":1,\"command\":\"ls\",\"requestId\":\"req-2\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(ErrorCode.FORBIDDEN_ERROR.getCode()));
    }

    @Test
    void runNotOwnedByDeclaredApplicationSurfacesAsNotFound() throws Exception {
        when(executionService.renewLease(any(), any(), any(), any(), any())).thenThrow(
            new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 不属于该 Application")
        );

        mockMvc
            .perform(
                post("/platform/runs/execution/lease/renew")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"fenceToken\":" + FENCE_TOKEN + ",\"requestId\":\"req-3\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(ErrorCode.NOT_FOUND_ERROR.getCode()));
    }

    @Test
    void commandAndResultRequestsReachServiceWithDeclaredArguments() throws Exception {
        PlatformRunCommandResultVO commandResult = new PlatformRunCommandResultVO();
        commandResult.setRunId(RUN_ID);
        commandResult.setExitCode(0);
        commandResult.setStdout("ok\n");
        commandResult.setStderr("");
        commandResult.setDurationMs(12L);
        when(executionService.execute(
            eq(APPLICATION_ID),
            eq(RUN_ID),
            eq(FENCE_TOKEN),
            eq("npm run build"),
            eq(120),
            eq("req-4")
        )).thenReturn(commandResult);

        mockMvc
            .perform(
                post("/platform/runs/execution/commands")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"fenceToken\":" + FENCE_TOKEN
                            + ",\"command\":\"npm run build\",\"timeoutSeconds\":120,\"requestId\":\"req-4\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0))
            .andExpect(jsonPath("$.data.exitCode").value(0))
            .andExpect(jsonPath("$.data.stdout").value("ok\n"));

        mockMvc
            .perform(
                post("/platform/runs/execution/results")
                    .contentType(MediaType.APPLICATION_JSON)
                    .content(
                        "{\"applicationId\":\"" + APPLICATION_ID + "\",\"runId\":\"" + RUN_ID
                            + "\",\"fenceToken\":" + FENCE_TOKEN
                            + ",\"outcome\":\"SUCCEEDED\",\"reasonCode\":\"RUN_FINISHED\""
                            + ",\"evidenceRef\":\"artifact-1\",\"requestId\":\"req-5\"}"
                    )
            )
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value(0));
        verify(executionService).reportResult(
            APPLICATION_ID,
            RUN_ID,
            FENCE_TOKEN,
            "SUCCEEDED",
            "RUN_FINISHED",
            "artifact-1",
            "req-5"
        );
    }

    /** MockMvc 默认 remote addr 是 127.0.0.1，因此拒绝路径必须显式改写对端地址。 */
    private RequestPostProcessor remoteAddress(String address) {
        return request -> {
            request.setRemoteAddr(address);
            return request;
        };
    }

    private PlatformRunLeaseGrantVO grant() {
        PlatformRunLeaseVO lease = new PlatformRunLeaseVO();
        lease.setRunId(RUN_ID);
        lease.setApplicationId(APPLICATION_ID);
        lease.setTaskId("9001");
        lease.setFenceToken(FENCE_TOKEN);
        lease.setGrantedAt(LocalDateTime.of(2026, 1, 1, 0, 0));
        lease.setExpiresAt(LocalDateTime.of(2026, 1, 1, 0, 1));
        lease.setRenewCount(0);

        PlatformRunLeaseGrantVO granted = new PlatformRunLeaseGrantVO();
        granted.setLease(lease);
        granted.setCapabilities(capabilities());
        granted.setBaselineJson("{\"schemaVersion\":1}");
        return granted;
    }

    private PlatformExecutionCapabilitiesVO capabilities() {
        PlatformExecutionCapabilitiesVO capabilities = new PlatformExecutionCapabilitiesVO();
        capabilities.setWorkspacePath("/workspace");
        capabilities.setWorkspacePersistent(false);
        capabilities.setNetworkAccessAvailable(false);
        capabilities.setReadonlyRootFilesystem(true);
        return capabilities;
    }

    /**
     * 阻断请求走执行通道而不是工作项通道：它要求调用方仍持有该 Run 的 Lease。
     *
     * <p>这两件事必须同时成立——端点位置错了，Runtime 就只能绕过围栏；位置对了，
     * 也不代表围栏被跳过。
     */
    @Test
    void blockRequestRequiresAHeldLeaseAndValidatesTheQuestionBeforeTearingDownTheRun() throws Exception {
        PlatformRunBlockRequest request = new PlatformRunBlockRequest();
        request.setApplicationId("460017668615995392");
        request.setRunId("run-7001");
        request.setFenceToken("3");
        request.setBlockingQuestion("生成的页面需要支持哪些角色？");
        request.setRequestId("block-1");

        mockMvc.perform(post("/platform/runs/execution/blocks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(request)))
            .andExpect(jsonPath("$.code").value(0));

        verify(executionService).blockForClarification(
            "460017668615995392", "run-7001", 3L, "生成的页面需要支持哪些角色？", "block-1");
    }

    @Test
    void blockRequestFromANonLoopbackCallerIsRejected() throws Exception {
        PlatformRunBlockRequest request = new PlatformRunBlockRequest();
        request.setApplicationId("460017668615995392");
        request.setRunId("run-7001");
        request.setFenceToken("3");
        request.setBlockingQuestion("问题？");
        request.setRequestId("block-2");

        mockMvc.perform(post("/platform/runs/execution/blocks")
                .with(builder -> {
                    builder.setRemoteAddr("10.0.0.7");
                    return builder;
                })
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(request)))
            .andExpect(jsonPath("$.code").value(ErrorCode.FORBIDDEN_ERROR.getCode()));

        verify(executionService, never()).blockForClarification(
            anyString(), anyString(), any(), anyString(), anyString());
    }

    @Test
    void aMalformedFenceTokenIsRejectedBeforeTheRunIsTouched() throws Exception {
        PlatformRunBlockRequest request = new PlatformRunBlockRequest();
        request.setApplicationId("460017668615995392");
        request.setRunId("run-7001");
        // JavaScript 无法无损承载 long：fence token 必须以字符串传输，用 number 会被误拒。
        request.setFenceToken("9007199254740993");
        request.setBlockingQuestion("问题？");
        request.setRequestId("block-3");

        mockMvc.perform(post("/platform/runs/execution/blocks")
                .contentType(MediaType.APPLICATION_JSON)
                .content(mapper.writeValueAsString(request)))
            .andExpect(jsonPath("$.code").value(0));

        verify(executionService).blockForClarification(
            eq("460017668615995392"), eq("run-7001"), eq(9007199254740993L),
            anyString(), anyString());
    }
}
