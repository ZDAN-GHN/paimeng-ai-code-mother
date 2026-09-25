package com.zdan.paimengaicodebackend.platform.controller;

import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunCommandRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunLeaseGrantRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunLeaseReleaseRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunLeaseRenewRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunResultRequest;
import com.zdan.paimengaicodebackend.platform.dto.PlatformRunRecoveryRequest;
import com.zdan.paimengaicodebackend.platform.service.PlatformRunExecutionService;
import com.zdan.paimengaicodebackend.platform.vo.PlatformExecutionCapabilitiesVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunCommandResultVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseGrantVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRunLeaseVO;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 受控 Run 执行端点（Issue #77 / T-05）：Runtime 经此申请写入权、在 Sandbox 内执行命令、
 * 上报结果。
 *
 * <p><strong>TODO（入站鉴权延后，维护者决策）：本端点组无鉴权。禁止部署到共享或公网环境。
 * </strong>补齐鉴权前，可达性只由两条围栏兜底：
 *
 * <ol>
 *   <li>{@code platform.execution.enabled} 默认 {@code false}，未显式开启时本控制器不注册；</li>
 *   <li>即使开启，也只接受回环调用方——见 {@link #requireLoopbackCaller}。</li>
 * </ol>
 *
 * <p>这两条不是鉴权的替代品，只是把「忘记加鉴权」的后果从「公网可写」降到「本机可写」。
 * 任何要让非本机调用方访问的需求，都应先补鉴权，而不是放宽这里。
 */
@RestController
@RequestMapping("/platform/runs/execution")
@ConditionalOnProperty(prefix = "platform.execution", name = "enabled", havingValue = "true")
@Tag(name = "Platform Run Execution", description = "受控 Run 执行：Lease、Sandbox 命令、结果上报")
public class PlatformRunExecutionController {

    /** 回环地址的全部表示形式。IPv4、IPv6 与 IPv4-mapped IPv6 都要覆盖。 */
    private static final Set<String> LOOPBACK_ADDRESSES = Set.of(
        "127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "::1",
        "::ffff:127.0.0.1"
    );

    private final PlatformRunExecutionService executionService;

    public PlatformRunExecutionController(PlatformRunExecutionService executionService) {
        this.executionService = executionService;
    }

    @PostMapping("/lease")
    @Operation(summary = "申请 Run 写入 Lease，并返回执行环境能力")
    public BaseResponse<PlatformRunLeaseGrantVO> grantLease(
        @RequestBody PlatformRunLeaseGrantRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        return ResultUtils.success(
            executionService.grantLease(
                request.getApplicationId(),
                request.getRunId(),
                request.getReasonCode(),
                request.getRequestId(),
                request.getRecoveryProtocolVersion()
            )
        );
    }

    @PostMapping("/recovery/prepare")
    @Operation(summary = "确认空 Workspace 并登记请求前恢复检查点")
    public BaseResponse<Boolean> prepareRecovery(
        @RequestBody PlatformRunRecoveryRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        executionService.prepareRecovery(
            request.getApplicationId(), request.getRunId(), request.getFenceToken(), request.getRequestId()
        );
        return ResultUtils.success(true);
    }

    @PostMapping("/recovery/begin")
    @Operation(summary = "在首次模型请求前关闭 Run 重启接管窗口")
    public BaseResponse<Boolean> beginExecution(
        @RequestBody PlatformRunRecoveryRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        executionService.beginExecution(
            request.getApplicationId(), request.getRunId(), request.getFenceToken(), request.getRequestId()
        );
        return ResultUtils.success(true);
    }

    @PostMapping("/lease/renew")
    @Operation(summary = "续租 Run 写入 Lease")
    public BaseResponse<PlatformRunLeaseVO> renewLease(
        @RequestBody PlatformRunLeaseRenewRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        return ResultUtils.success(
            executionService.renewLease(
                request.getApplicationId(),
                request.getRunId(),
                request.getFenceToken(),
                request.getReasonCode(),
                request.getRequestId()
            )
        );
    }

    @PostMapping("/lease/release")
    @Operation(summary = "停止 Sandbox 并释放 Run 写入 Lease")
    public BaseResponse<Boolean> releaseLease(
        @RequestBody PlatformRunLeaseReleaseRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        executionService.releaseLease(
            request.getApplicationId(),
            request.getRunId(),
            request.getFenceToken(),
            request.getReasonCode(),
            request.getRequestId()
        );
        return ResultUtils.success(true);
    }

    @PostMapping("/commands")
    @Operation(summary = "在 Run 的 Sandbox 内执行命令")
    public BaseResponse<PlatformRunCommandResultVO> executeCommand(
        @RequestBody PlatformRunCommandRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        return ResultUtils.success(
            executionService.execute(
                request.getApplicationId(),
                request.getRunId(),
                request.getFenceToken(),
                request.getCommand(),
                request.getTimeoutSeconds(),
                request.getRequestId()
            )
        );
    }

    @PostMapping("/results")
    @Operation(summary = "上报 Run 终态：停容器、释放 Lease、写入终态")
    public BaseResponse<Boolean> reportResult(
        @RequestBody PlatformRunResultRequest request,
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        requireBody(request);
        executionService.reportResult(
            request.getApplicationId(),
            request.getRunId(),
            request.getFenceToken(),
            request.getOutcome(),
            request.getReasonCode(),
            request.getEvidenceRef(),
            request.getRequestId()
        );
        return ResultUtils.success(true);
    }

    @GetMapping("/capabilities")
    @Operation(summary = "读取受控执行环境能力（不需要持有 Lease）")
    public BaseResponse<PlatformExecutionCapabilitiesVO> readCapabilities(
        HttpServletRequest servletRequest
    ) {
        requireLoopbackCaller(servletRequest);
        return ResultUtils.success(executionService.buildCapabilities());
    }

    /**
     * 只接受回环调用方。
     *
     * <p>判据取 {@code getRemoteAddr()}——TCP 对端地址，不是任何可伪造的请求头。
     * {@code X-Forwarded-For} 之类由调用方填写的值在此一律不参与判断。
     *
     * <p>反向代理转发会使对端变成代理本身，因此本端点不应放在代理之后；那种部署形态需要的是
     * 真正的鉴权，而不是把这里改宽。
     */
    private void requireLoopbackCaller(HttpServletRequest request) {
        String remoteAddress = request.getRemoteAddr();
        if (remoteAddress == null || !LOOPBACK_ADDRESSES.contains(remoteAddress)) {
            throw new BusinessException(
                ErrorCode.FORBIDDEN_ERROR,
                "受控执行端点只接受本机调用"
            );
        }
    }

    private void requireBody(Object request) {
        if (request == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR);
        }
    }
}
