package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformStatusStreamRegistry;
import com.zdan.paimengaicodebackend.platform.dto.PlatformClarificationAnswerRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformTaskRetryRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformApplicationStatusService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationStatusVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformClarificationAnswerVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformTaskRetryVO;
import com.zdan.paimengaicodebackend.service.UserService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Owner 可见的执行状态与阻断答复（Issue #80 / T-08）
 *
 * <p>与 {@link PlatformApplicationController} 共用 {@code Platform Application} 标签，
 * 因此前端 {@code npm run openapi2ts} 会把这两个端点生成到同一个 API 模块，状态类型
 * 由 OpenAPI 单一来源生成而不是手写。
 *
 * <p>状态流只推送「状态可能变了」的信号，每次都由
 * {@link PlatformApplicationStatusService} 重新读取权威投影再输出，因此 SSE 通道不是
 * 第二个状态来源。
 */
@RestController
@RequestMapping("/platform/applications")
@Tag(name = "Platform Application", description = "Owner Application 管理与 Requirement 接收")
public class PlatformApplicationStatusController {

    private static final String STATUS_EVENT = "status";

    private final PlatformApplicationStatusService statusService;
    private final PlatformStatusStreamRegistry streamRegistry;
    private final UserService userService;

    public PlatformApplicationStatusController(
        PlatformApplicationStatusService statusService,
        PlatformStatusStreamRegistry streamRegistry,
        UserService userService
    ) {
        this.statusService = statusService;
        this.streamRegistry = streamRegistry;
        this.userService = userService;
    }

    @GetMapping("/{applicationId}/status")
    @Operation(summary = "读取 Owner 可见的 Application 执行状态")
    public BaseResponse<PlatformApplicationStatusVO> getStatus(
        @Parameter(description = "Application ID", schema = @Schema(type = "string"))
        @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(statusService.getStatus(applicationId, loginUser(servletRequest)));
    }

    @GetMapping(value = "/{applicationId}/status/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @Operation(summary = "订阅 Owner 可见的 Application 执行状态变化")
    public SseEmitter streamStatus(
        @Parameter(description = "Application ID", schema = @Schema(type = "string"))
        @PathVariable Long applicationId,
        HttpServletRequest servletRequest
    ) {
        // 订阅时立刻完成主体校验：鉴权失败必须是普通错误响应，而不是一条永远不推送的流。
        User actor = loginUser(servletRequest);
        statusService.getStatus(applicationId, actor);
        return streamRegistry.subscribe(applicationId, UUID.randomUUID().toString(),
            emitter -> pushStatus(emitter, applicationId, actor));
    }

    @PostMapping("/{applicationId}/clarification-answers")
    @Operation(summary = "提交唯一阻断问题的答复并重新归一化")
    public BaseResponse<PlatformClarificationAnswerVO> answerBlockingQuestion(
        @Parameter(description = "Application ID", schema = @Schema(type = "string"))
        @PathVariable Long applicationId,
        @RequestBody PlatformClarificationAnswerRequest request,
        HttpServletRequest servletRequest
    ) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
        return ResultUtils.success(statusService.answerBlockingQuestion(
            applicationId, request.getTaskId(), request.getAnswerText(), loginUser(servletRequest)));
    }

    @PostMapping("/{applicationId}/tasks/{taskId}/retries")
    @Operation(summary = "Owner 对失败的 Task 请求重试；Requirement 与冻结基线保持不变")
    public BaseResponse<PlatformTaskRetryVO> requestRetry(
        @Parameter(description = "Application ID", schema = @Schema(type = "string"))
        @PathVariable Long applicationId,
        @Parameter(description = "Task ID", schema = @Schema(type = "string"))
        @PathVariable String taskId,
        @RequestBody(required = false) PlatformTaskRetryRequest request,
        HttpServletRequest servletRequest
    ) {
        return ResultUtils.success(
            statusService.requestRetry(applicationId, taskId, request, loginUser(servletRequest)));
    }

    private void pushStatus(SseEmitter emitter, Long applicationId, User actor) {
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("type", STATUS_EVENT);
            payload.put("status", statusService.getStatus(applicationId, actor));
            emitter.send(SseEmitter.event().name(STATUS_EVENT).data(payload));
        } catch (IOException broken) {
            throw new IllegalStateException("Owner 状态流已断开", broken);
        }
    }

    private User loginUser(HttpServletRequest request) {
        return userService.getLoginUser(request);
    }
}
