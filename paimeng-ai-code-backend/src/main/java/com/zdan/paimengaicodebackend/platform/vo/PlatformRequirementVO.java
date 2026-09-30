package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Schema(description = "不可变 Requirement 视图")
public class PlatformRequirementVO {

    @Schema(description = "Requirement 标识；以十进制字符串传输，避免 JavaScript 精度丢失", example = "460017668615995393")
    private String id;

    @Schema(description = "所属 Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "未经归一化的原文")
    private String originalText;

    @Schema(description = "Requirement 类型；OWNER_REQUEST 为 Owner 原始需求，CLARIFICATION_ANSWER 为阻断答复",
        example = "OWNER_REQUEST", allowableValues = {"OWNER_REQUEST", "CLARIFICATION_ANSWER"})
    private String kind;

    @Schema(description = "归一化状态；由 Platform 归一化队列事实投影，未入队时为 PENDING_NORMALIZATION",
        example = "BLOCKED")
    private String normalizationStatus;

    @Schema(description = "提交时间")
    private LocalDateTime createdAt;
}
