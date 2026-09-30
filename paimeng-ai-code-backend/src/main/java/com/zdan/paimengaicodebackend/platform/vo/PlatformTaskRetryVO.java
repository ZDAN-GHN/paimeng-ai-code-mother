package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * Owner 重试受理回执（Issue #80 / Slice 2）
 *
 * <p>刻意不含基线与验收目标：D-06 规定重试保持 Requirement 与冻结基线不变，
 * 契约里没有位置承载「顺便改一下目标」，也就没有实现它的机会。
 */
@Data
@Schema(description = "Owner 重试受理回执")
public class PlatformTaskRetryVO {

    @Schema(description = "被重试的 Task 标识；以十进制字符串传输", example = "460017668615995394")
    private String taskId;

    @Schema(description = "重试创建的新受控 Run 标识；Agent 将通过既有工作项领取它",
        example = "run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String runId;

    @Schema(description = "第几次尝试；重试递增，上一次 Run 的终态保持不变", example = "2")
    private Integer attemptNumber;

    @Schema(description = "受理时间")
    private LocalDateTime acceptedAt;
}
