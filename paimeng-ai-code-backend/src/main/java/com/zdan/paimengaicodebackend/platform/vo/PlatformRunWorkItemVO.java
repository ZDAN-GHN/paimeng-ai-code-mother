package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

/**
 * 领取到的受控 Run 工作项（Issue #80 / T-08）
 *
 * <p>只暴露 Run 身份：Baseline 与执行环境能力仍然由 {@code /platform/runs/execution/lease}
 * 在授予 fenced Lease 时返回，因此「拿到工作项」不等于「拿到写入权」。
 */
@Data
@Schema(description = "待启动的受控 Run 工作项")
public class PlatformRunWorkItemVO {

    @Schema(description = "Application 标识；以十进制字符串传输", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "Task 标识；以十进制字符串传输", example = "460017668615995394")
    private String taskId;

    @Schema(description = "Run 标识", example = "run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String runId;

    @Schema(description = "第几次尝试；从 1 开始", example = "1")
    private Integer attemptNumber;
}
