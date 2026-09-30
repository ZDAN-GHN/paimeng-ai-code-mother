package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

/**
 * 领取到的归一化工作项（Issue #80 / T-08）
 *
 * <p>Agent 只能拿到 Platform 已经持久化的 Requirement 原文与 Task 归属；它不能选择
 * 归一化哪个 Requirement，也不能在这里看到 Profile、Snapshot 或任何既有版本事实。
 */
@Data
@Schema(description = "待归一化的 Requirement 工作项")
public class PlatformNormalizationWorkItemVO {

    @Schema(description = "Application 标识；以十进制字符串传输", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "Requirement 标识；以十进制字符串传输", example = "460017668615995393")
    private String requirementId;

    @Schema(description = "Task 标识；以十进制字符串传输", example = "460017668615995394")
    private String taskId;

    @Schema(description = "归一化尝试凭据；回写结果时必须原样携带",
        example = "1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String attemptId;

    @Schema(description = "Requirement 原文", example = "我想要一个预约管理的小程序")
    private String requirementText;

    @Schema(description = "Requirement 类型；CLARIFICATION_ANSWER 表示这是对阻断问题的答复",
        example = "OWNER_REQUEST", allowableValues = {"OWNER_REQUEST", "CLARIFICATION_ANSWER"})
    private String requirementKind;

    @Schema(description = "被答复的原 Requirement 标识；OWNER_REQUEST 时为空", example = "460017668615995393")
    private String parentRequirementId;

    @Schema(description = "被答复的原 Requirement 原文；OWNER_REQUEST 时为空。重新归一化必须同时看到原始需求与答复，否则答复会脱离上下文",
        example = "我想要一个预约管理的小程序")
    private String parentRequirementText;
}
