package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;

public record TaskExecutionBaseline(
    int schemaVersion,
    Long baseProfileVersion,
    String baseSourceRevision,
    String requestedOutcome,
    String acceptanceTarget
) {
    public static final int CURRENT_SCHEMA_VERSION = 1;

    public TaskExecutionBaseline {
        if (schemaVersion != CURRENT_SCHEMA_VERSION) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "TaskExecutionBaseline schema version 不支持");
        }
        if (requestedOutcome == null || requestedOutcome.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "requestedOutcome 不能为空");
        }
        if (acceptanceTarget == null || acceptanceTarget.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "acceptanceTarget 不能为空");
        }
    }
}
