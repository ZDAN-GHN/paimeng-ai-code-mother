package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

/**
 * Runtime 上报的粗粒度执行阶段（Issue #80 / T-08）
 *
 * <p>刻意只有阶段与一句说明：Agent 的工具名、参数、命令输出、Pi Session 与 Sandbox
 * 标识都不在契约内，因为这份数据会直接进入 Owner 可见的状态投影。
 */
@Data
@Schema(description = "Runtime 执行进度上报")
public class PlatformRunProgressRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Schema(description = "Application 标识；以十进制字符串传输", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "Run 标识；归一化阶段还没有 Run 时可为空", example = "run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String runId;

    @Schema(description = "粗粒度阶段", example = "EXECUTING",
        allowableValues = {"NORMALIZING", "NORMALIZATION_BLOCKED", "EXECUTING", "VALIDATING", "VALIDATION_FAILED"})
    private String stage;

    @Schema(description = "一句审计说明；为空时 Platform 使用阶段自带的说明。该字段只落进度事件表，"
        + "不进入 Owner 状态投影", example = "正在生成页面与数据表")
    private String note;

    @Schema(description = "调用方幂等键", example = "progress-1f0c2f2a")
    private String requestId;
}
