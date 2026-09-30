package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

/** Owner 对唯一决定性业务问题的答复。只接受自然语言，不接受状态声明。 */
@Data
@Schema(description = "阻断问题答复")
public class PlatformClarificationAnswerRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Schema(description = "被答复的 Task 标识；以十进制字符串传输，避免 JavaScript 精度丢失",
        example = "460017668615995394")
    private String taskId;

    @Schema(description = "Owner 的自然语言答复", example = "客户可以提前 14 天预约，也可以当天预约。")
    private String answerText;
}
