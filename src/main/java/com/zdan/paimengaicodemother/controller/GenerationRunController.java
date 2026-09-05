package com.zdan.paimengaicodemother.controller;

import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.common.BaseResponse;
import com.zdan.paimengaicodemother.common.ResultUtils;
import com.zdan.paimengaicodemother.config.InternalApiProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ConcurrentRunException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodemother.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodemother.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodemother.model.dto.run.WireframeQuotaRequest;
import com.zdan.paimengaicodemother.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodemother.model.vo.RunVO;
import com.zdan.paimengaicodemother.service.GenerationRunService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 生成运行（generation_run）内部 API 控制层
 * 仅 TS Agent 以 Bearer 服务令牌调用（TS Agent 不直连 MySQL，run 状态经本组端点读写）；
 * 无/错 Bearer → 401；同 app 并发 run → 409「当前有进行中的任务」；runId 幂等。
 *
 * @author LXH
 */
@Slf4j
@RestController
@RequestMapping("/internal")
public class GenerationRunController {

    /**
     * Bearer 前缀
     */
    private static final String BEARER_PREFIX = "Bearer ";

    private final GenerationRunService generationRunService;
    private final InternalApiProperties internalApiProperties;

    public GenerationRunController(GenerationRunService generationRunService,
                                   InternalApiProperties internalApiProperties) {
        this.generationRunService = generationRunService;
        this.internalApiProperties = internalApiProperties;
    }

    /**
     * 创建 run（幂等：同 runId 返回既有 run；同 app 并发 → 409）
     *
     * @param request       创建请求
     * @param authorization Authorization 头
     * @return run
     */
    @PostMapping("/runs")
    public ResponseEntity<BaseResponse<RunVO>> createRun(@RequestBody RunCreateRequest request,
                                                         @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.createRun(request)));
    }

    /**
     * 按 runId 更新 run（phase/上下文/里程碑/计量；幂等更新）
     *
     * @param runId         运行 id
     * @param request       更新请求
     * @param authorization Authorization 头
     * @return run
     */
    @PatchMapping("/runs/{runId}")
    public ResponseEntity<BaseResponse<RunVO>> updateRun(@PathVariable String runId,
                                                         @RequestBody RunUpdateRequest request,
                                                         @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.updateRun(runId, request)));
    }

    /**
     * 按 runId 查询 run
     *
     * @param runId         运行 id
     * @param authorization Authorization 头
     * @return run，不存在 data 为 null
     */
    @GetMapping("/runs/{runId}")
    public ResponseEntity<BaseResponse<RunVO>> getRun(@PathVariable String runId,
                                                      @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.getByRunId(runId)));
    }

    /**
     * 查询同 app 最新非终态 run（断点续传的查询基础）
     *
     * @param appId         应用 id
     * @param userId        用户 id（可选）
     * @param authorization Authorization 头
     * @return 最新非终态 run，无则 data 为 null
     */
    @GetMapping("/apps/{appId}/runs/latest-nonterminal")
    public ResponseEntity<BaseResponse<RunVO>> getLatestNonTerminalRun(@PathVariable Long appId,
                                                                       @RequestParam(required = false) Long userId,
                                                                       @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.getLatestNonTerminalRun(appId, userId)));
    }

    /**
     * Agent 完成回调（Issue #6）：写对话历史 + success 触发构建
     * Bearer + runId 幂等（同 runId 重复回调返回 200 丢弃，不重复写历史/构建）
     *
     * @param runId         运行 id（幂等键）
     * @param request       完成回调请求
     * @param authorization Authorization 头
     * @return 处理结果
     */
    @PostMapping("/agent/runs/{runId}/complete")
    public ResponseEntity<BaseResponse<Boolean>> completeRun(@PathVariable String runId,
                                                             @RequestBody AgentCompleteRequest request,
                                                             @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        generationRunService.completeRun(runId, request);
        return ResponseEntity.ok(ResultUtils.success(true));
    }

    /**
     * 线框生成每日配额（Issue #7）：线框免费 + 每用户每日独立限频（复用 Redisson 限流机制）
     * 超出 → 429「今日线框生成次数已用完，请明天再试」；TS Agent 生成线框前调用
     *
     * @param request      配额请求（userId）
     * @param authorization Authorization 头
     * @return 配额获取结果
     */
    @PostMapping("/agent/wireframe/quota/acquire")
    public ResponseEntity<BaseResponse<Boolean>> acquireWireframeQuota(@RequestBody WireframeQuotaRequest request,
                                                                       @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.acquireWireframeDailyQuota(request.getUserId())));
    }

    /**
     * 冻结积分（Issue #10）：TS Agent 在「确认线框进入 codegen」时刻调用（架构 §7 扣费协议）
     * 冻结额 = 基础价 × 生成类型系数 × 强度档位系数；余额不足 → 40201（TS Agent 映射为 error 事件拒绝 codegen）；
     * 同 runId 幂等（重复冻结返回既有台账不重复扣款）
     *
     * @param runId         运行 id（幂等键）
     * @param request       冻结请求（intensity）
     * @param authorization Authorization 头
     * @return 冻结结果（台账 id / 冻结额 / 余额）
     */
    @PostMapping("/agent/runs/{runId}/credit/freeze")
    public ResponseEntity<BaseResponse<CreditFreezeVO>> freezeCredit(@PathVariable String runId,
                                                                     @RequestBody(required = false) CreditFreezeRequest request,
                                                                     @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.freezeCredit(runId, request)));
    }

    /**
     * 校验内部 Bearer 服务令牌（无/错 → 401）
     *
     * @param authorization Authorization 头
     */
    private void checkInternalAuth(String authorization) {
        String expected = BEARER_PREFIX + internalApiProperties.getToken();
        if (StrUtil.isBlank(internalApiProperties.getToken()) || !expected.equals(authorization)) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "非法调用");
        }
    }

    /**
     * 同 app 并发 run → 409「当前有进行中的任务」
     *
     * @param e 并发异常
     * @return 409 响应
     */
    @ExceptionHandler(ConcurrentRunException.class)
    public ResponseEntity<BaseResponse<?>> handleConcurrentRun(ConcurrentRunException e) {
        log.warn("拒绝并发 run：{}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(ResultUtils.error(ErrorCode.OPERATION_ERROR.getCode(), e.getMessage()));
    }

    /**
     * 内部端点的业务异常 → 按错误码映射 HTTP 状态（替代全局 handler 的 200 返回）
     *
     * @param e 业务异常
     * @return 映射后的响应
     */
    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<BaseResponse<?>> handleBusiness(BusinessException e) {
        return ResponseEntity.status(mapHttpStatus(e.getCode()))
                .body(ResultUtils.error(e.getCode(), e.getMessage()));
    }

    /**
     * 业务错误码 → HTTP 状态码
     *
     * @param code 业务错误码
     * @return HTTP 状态码
     */
    private int mapHttpStatus(int code) {
        if (code == ErrorCode.NOT_LOGIN_ERROR.getCode() || code == ErrorCode.NO_AUTH_ERROR.getCode()) {
            return HttpStatus.UNAUTHORIZED.value();
        }
        if (code == ErrorCode.PARAMS_ERROR.getCode()) {
            return HttpStatus.BAD_REQUEST.value();
        }
        if (code == ErrorCode.FORBIDDEN_ERROR.getCode()) {
            return HttpStatus.FORBIDDEN.value();
        }
        if (code == ErrorCode.NOT_FOUND_ERROR.getCode()) {
            return HttpStatus.NOT_FOUND.value();
        }
        if (code == ErrorCode.TOO_MANY_REQUEST.getCode()) {
            return HttpStatus.TOO_MANY_REQUESTS.value();
        }
        if (code == ErrorCode.CREDIT_NOT_ENOUGH.getCode()) {
            // 402 Payment Required：余额不足（TS Agent 据此映射「积分不足」error 事件拒绝 codegen）
            return HttpStatus.PAYMENT_REQUIRED.value();
        }
        return HttpStatus.INTERNAL_SERVER_ERROR.value();
    }
}
