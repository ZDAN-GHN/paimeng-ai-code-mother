package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

/**
 * Runtime 在受控执行中发现决定性业务歧义时的阻断上报（Issue #80 / T-08）
 *
 * <p>Agent 只能「提出问题」，不能自己改写 Task 状态。Platform 接受后会先停止 Sandbox、
 * 释放 Lease、让 Run 进入终态，再把 Task 落到 {@code blocked} 并记录这个问题。
 * 冻结基线不会被修改；Owner 答复后按 D-06 为重新归一化创建新 Task。
 */
@Data
@Schema(description = "受控执行中的业务歧义阻断上报")
public class PlatformRunBlockRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Schema(description = "Application 标识；以十进制字符串传输", example = "460017668615995392")
    private String applicationId;

    @Schema(description = "Run 标识", example = "run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String runId;

    @Schema(description = "当前持有的 fence token；以字符串传输避免精度丢失", example = "3")
    private String fenceToken;

    @Schema(description = "唯一的决定性业务问题", example = "生成的页面需要支持哪些角色？")
    private String blockingQuestion;

    @Schema(description = "调用方幂等键", example = "block-1f0c2f2a")
    private String requestId;
}
