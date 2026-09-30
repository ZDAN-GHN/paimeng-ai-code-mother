package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

/**
 * Agent 归一化结果回写（Issue #80 / T-08）
 *
 * <p>{@code attemptId} 是领取时 Platform 发出的凭据：没有它、或租约已过期，
 * 结果一律被拒绝，因此 Agent 不能凭空声明某次归一化成功。
 *
 * <p>{@code READY} 必须给出 {@code requestedOutcome} 与 {@code acceptanceTarget}；
 * {@code BLOCKED} 必须给出唯一的 {@code blockingQuestion}；{@code FAILED} 只允许
 * {@code reasonCode}。三者的必填组合在 Platform 侧强制，不依赖 Agent 自律。
 */
@Data
@Schema(description = "Agent 归一化结果回写")
public class PlatformNormalizationResultRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    public static final String OUTCOME_READY = "READY";
    public static final String OUTCOME_BLOCKED = "BLOCKED";
    public static final String OUTCOME_FAILED = "FAILED";

    @Schema(description = "Application 标识；以十进制字符串传输", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "Task 标识；以十进制字符串传输", example = "460017668615995394")
    private String taskId;

    @Schema(description = "领取时 Platform 发出的归一化尝试凭据",
        example = "1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String attemptId;

    @Schema(description = "归一化结论", example = "READY",
        allowableValues = {OUTCOME_READY, OUTCOME_BLOCKED, OUTCOME_FAILED})
    private String outcome;

    @Schema(description = "outcome 为 READY 时的期望业务结果",
        example = "Create an appointment intake workflow")
    private String requestedOutcome;

    @Schema(description = "outcome 为 READY 时的验收目标",
        example = "An owner can submit an appointment request and view its status")
    private String acceptanceTarget;

    @Schema(description = "outcome 为 BLOCKED 时唯一的决定性业务问题",
        example = "客户可以提前几天预约？")
    private String blockingQuestion;

    @Schema(description = "outcome 为 FAILED 时的原因码", example = "NORMALIZATION_MODEL_UNAVAILABLE")
    private String reasonCode;

    @Schema(description = "调用方幂等键", example = "normalize-1f0c2f2a")
    private String requestId;
}
