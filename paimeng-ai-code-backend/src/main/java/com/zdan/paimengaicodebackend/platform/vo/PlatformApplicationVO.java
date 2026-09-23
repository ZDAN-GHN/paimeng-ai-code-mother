package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Schema(description = "Platform Application 管理视图")
public class PlatformApplicationVO {

    @Schema(description = "Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失", example = "460017668615995392")
    private String id;

    @Schema(description = "Application 名称")
    private String name;

    @Schema(description = "Owner 用户标识；以十进制字符串传输，避免 JavaScript 精度丢失", example = "377708067863715840")
    private String ownerId;

    @Schema(description = "生命周期状态", example = "ACTIVE")
    private String lifecycleStatus;

    @Schema(description = "公开可用性", example = "NOT_PROVISIONED")
    private String publicAvailability;

    @Schema(description = "关联事实是否保留")
    private boolean retained;

    @Schema(description = "MVP 是否支持恢复")
    private boolean recoverySupported;

    @Schema(description = "归档时间")
    private LocalDateTime archivedAt;

    @Schema(description = "归档操作人；以十进制字符串传输，避免 JavaScript 精度丢失", example = "377708067863715840")
    private String archivedBy;
}
