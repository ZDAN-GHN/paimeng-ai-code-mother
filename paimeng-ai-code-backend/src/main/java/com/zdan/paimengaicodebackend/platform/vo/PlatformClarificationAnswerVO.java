package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

/** Owner 提交唯一阻断问题答复后的回执。 */
@Data
@Schema(description = "阻断答复受理结果")
public class PlatformClarificationAnswerVO {

    @Schema(description = "不可变答复 Requirement 标识；以十进制字符串传输", example = "460017668615995395")
    private String answerRequirementId;

    @Schema(description = "将被重新归一化的 Task 标识；以十进制字符串传输", example = "460017668615995394")
    private String taskId;

    @Schema(description = "是否沿 D-06 的 blocked→created 边重开原 Task；已有冻结基线时为 false 且原 Task 保持 blocked",
        example = "true")
    private boolean reopenedSameTask;

    @Schema(description = "受理时间")
    private LocalDateTime acceptedAt;
}
