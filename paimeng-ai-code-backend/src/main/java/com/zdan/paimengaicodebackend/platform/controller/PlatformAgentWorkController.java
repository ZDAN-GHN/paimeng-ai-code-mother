package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLoopbackCallerGuard;
import com.zdan.paimengaicodebackend.platform.dto.PlatformNormalizationResultRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunProgressRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformAgentWorkService;
import com.zdan.paimengaicodebackend.platform.service.PlatformRunExecutionService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformNormalizationWorkItemVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunWorkItemVO;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Agent 工作项端点（Issue #80 / T-08）
 *
 * <p><strong>TODO（入站鉴权延后，维护者决策）：本端点组无鉴权。禁止部署到共享或公网环境。</strong>
 * 围栏与 {@link PlatformRunExecutionController} 完全相同：
 * {@code platform.execution.enabled} 默认关闭，开启后也只接受回环调用方
 * （见 {@link PlatformLoopbackCallerGuard}）。这两条不是鉴权的替代品。
 *
 * <p>Agent 在这里只做两件事：领取「现在该做什么」，以及凭 Platform 发出的令牌回报结果。
 * 它不能指定执行哪个 Requirement、不能声明 Task 状态，也不能在没有 fenced Lease 的
 * 情况下写入 Sandbox。
 */
@RestController
@RequestMapping("/platform/agent/work")
@ConditionalOnProperty(prefix = "platform.execution", name = "enabled", havingValue = "true")
@Tag(name = "Platform Agent Work", description = "Agent 归一化与受控 Run 工作项领取")
public class PlatformAgentWorkController {

    private final PlatformAgentWorkService workService;
    private final PlatformLoopbackCallerGuard loopbackGuard;

    public PlatformAgentWorkController(
        PlatformAgentWorkService workService,
        PlatformLoopbackCallerGuard loopbackGuard
    ) {
        this.workService = workService;
        this.loopbackGuard = loopbackGuard;
    }

    @PostMapping("/normalizations/claim")
    @Operation(summary = "领取一条待归一化的 Requirement；队列为空时 data 为 null")
    public BaseResponse<PlatformNormalizationWorkItemVO> claimNormalization(HttpServletRequest servletRequest) {
        loopbackGuard.requireLoopbackCaller(servletRequest);
        return ResultUtils.success(workService.claimNormalization().orElse(null));
    }

    @PostMapping("/normalizations/result")
    @Operation(summary = "回写归一化结果")
    public BaseResponse<Boolean> reportNormalization(
        @RequestBody PlatformNormalizationResultRequest request,
        HttpServletRequest servletRequest
    ) {
        loopbackGuard.requireLoopbackCaller(servletRequest);
        requireBody(request);
        workService.reportNormalization(request);
        return ResultUtils.success(true);
    }

    @PostMapping("/runs/claim")
    @Operation(summary = "领取一个待启动的受控 Run；队列为空时 data 为 null")
    public BaseResponse<PlatformRunWorkItemVO> claimRun(HttpServletRequest servletRequest) {
        loopbackGuard.requireLoopbackCaller(servletRequest);
        return ResultUtils.success(workService.claimRun().orElse(null));
    }

    @PostMapping("/progress")
    @Operation(summary = "上报粗粒度执行阶段")
    public BaseResponse<Boolean> reportProgress(
        @RequestBody PlatformRunProgressRequest request,
        HttpServletRequest servletRequest
    ) {
        loopbackGuard.requireLoopbackCaller(servletRequest);
        requireBody(request);
        workService.reportProgress(request);
        return ResultUtils.success(true);
    }

    private void requireBody(Object request) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
    }
}
