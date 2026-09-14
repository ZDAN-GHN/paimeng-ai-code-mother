package com.zdan.paimengaicodebackend.controller;

import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodebackend.common.BaseResponse;
import com.zdan.paimengaicodebackend.common.ResultUtils;
import com.zdan.paimengaicodebackend.config.InternalApiProperties;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ConcurrentRunException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.model.dto.run.AgentCompleteRequest;
import com.zdan.paimengaicodebackend.model.dto.run.CreditFreezeRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunCreateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.RunUpdateRequest;
import com.zdan.paimengaicodebackend.model.dto.run.WireframeQuotaRequest;
import com.zdan.paimengaicodebackend.model.vo.CreditFreezeVO;
import com.zdan.paimengaicodebackend.model.vo.RunVO;
import com.zdan.paimengaicodebackend.service.GenerationRunService;
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


@Slf4j
@RestController
@RequestMapping("/internal")
public class GenerationRunController {


    private static final String BEARER_PREFIX = "Bearer ";

    private final GenerationRunService generationRunService;
    private final InternalApiProperties internalApiProperties;

    public GenerationRunController(GenerationRunService generationRunService,
                                   InternalApiProperties internalApiProperties) {
        this.generationRunService = generationRunService;
        this.internalApiProperties = internalApiProperties;
    }


    @PostMapping("/runs")
    public ResponseEntity<BaseResponse<RunVO>> createRun(@RequestBody RunCreateRequest request,
                                                         @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.createRun(request)));
    }


    @PatchMapping("/runs/{runId}")
    public ResponseEntity<BaseResponse<RunVO>> updateRun(@PathVariable String runId,
                                                         @RequestBody RunUpdateRequest request,
                                                         @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.updateRun(runId, request)));
    }


    @GetMapping("/runs/{runId}")
    public ResponseEntity<BaseResponse<RunVO>> getRun(@PathVariable String runId,
                                                      @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.getByRunId(runId)));
    }


    @GetMapping("/apps/{appId}/runs/latest-nonterminal")
    public ResponseEntity<BaseResponse<RunVO>> getLatestNonTerminalRun(@PathVariable Long appId,
                                                                       @RequestParam(required = false) Long userId,
                                                                       @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.getLatestNonTerminalRun(appId, userId)));
    }


    @PostMapping("/agent/runs/{runId}/complete")
    public ResponseEntity<BaseResponse<Boolean>> completeRun(@PathVariable String runId,
                                                             @RequestBody AgentCompleteRequest request,
                                                             @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        generationRunService.completeRun(runId, request);
        return ResponseEntity.ok(ResultUtils.success(true));
    }


    @PostMapping("/agent/wireframe/quota/acquire")
    public ResponseEntity<BaseResponse<Boolean>> acquireWireframeQuota(@RequestBody WireframeQuotaRequest request,
                                                                       @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.acquireWireframeDailyQuota(request.getUserId())));
    }


    @PostMapping("/agent/runs/{runId}/credit/freeze")
    public ResponseEntity<BaseResponse<CreditFreezeVO>> freezeCredit(@PathVariable String runId,
                                                                     @RequestBody(required = false) CreditFreezeRequest request,
                                                                     @RequestHeader(value = "Authorization", required = false) String authorization) {
        checkInternalAuth(authorization);
        return ResponseEntity.ok(ResultUtils.success(generationRunService.freezeCredit(runId, request)));
    }


    private void checkInternalAuth(String authorization) {
        String expected = BEARER_PREFIX + internalApiProperties.getToken();
        if (StrUtil.isBlank(internalApiProperties.getToken()) || !expected.equals(authorization)) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "非法调用");
        }
    }


    @ExceptionHandler(ConcurrentRunException.class)
    public ResponseEntity<BaseResponse<?>> handleConcurrentRun(ConcurrentRunException e) {
        log.warn("拒绝并发 run：{}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(ResultUtils.error(ErrorCode.OPERATION_ERROR.getCode(), e.getMessage()));
    }


    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<BaseResponse<?>> handleBusiness(BusinessException e) {
        return ResponseEntity.status(mapHttpStatus(e.getCode()))
                .body(ResultUtils.error(e.getCode(), e.getMessage()));
    }


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

            return HttpStatus.PAYMENT_REQUIRED.value();
        }
        return HttpStatus.INTERNAL_SERVER_ERROR.value();
    }
}
