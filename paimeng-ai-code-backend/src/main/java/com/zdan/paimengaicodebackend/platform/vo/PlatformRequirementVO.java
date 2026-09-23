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

    @Schema(description = "归一化状态；本阶段固定为 PENDING_NORMALIZATION")
    private String normalizationStatus;

    @Schema(description = "提交时间")
    private LocalDateTime createdAt;
}
