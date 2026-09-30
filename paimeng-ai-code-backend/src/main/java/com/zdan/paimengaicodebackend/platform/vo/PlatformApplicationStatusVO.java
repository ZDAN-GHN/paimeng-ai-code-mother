package com.zdan.paimengaicodebackend.platform.vo;

import com.zdan.paimengaicodebackend.platform.domain.PlatformOwnerVisibleStatus;
import com.zdan.paimengaicodebackend.platform.domain.PlatformProgressStage;
import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * Owner 可见的 Application 执行状态（Issue #80 / T-08）
 *
 * <p>这是 Product Layer 的唯一执行状态出口。刻意不包含：Pi Session、工具名与参数、
 * 命令输出、Sandbox 标识、Snapshot 提交哈希、Validation Evidence 引用和任何生产信息。
 * Owner 需要的是「现在到哪一步、下一步做什么」，其余都是 Platform 内部证据。
 */
@Data
@Schema(description = "Owner 可见的 Application 执行状态投影")
public class PlatformApplicationStatusVO {

    @Schema(description = "Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失",
        example = "460017668615995392")
    private String applicationId;

    @Schema(description = "当前 Owner 可见状态", example = "AWAITING_NORMALIZATION")
    private PlatformOwnerVisibleStatus status;

    @Schema(description = "当前状态的 Owner 语言标题", example = "需求已接收，正在整理成可执行的开发目标")
    private String headline;

    @Schema(description = "Owner 下一步该做什么；不含任何内部执行细节", example = "我们正在把你的描述整理成可执行的开发目标。")
    private String detail;

    @Schema(description = "是否存在唯一待答复的阻断问题", example = "false")
    private boolean answerRequired;

    @Schema(description = "唯一的决定性业务问题；仅在 answerRequired 为 true 时出现", example = "预约需要提前几天？")
    private String blockingQuestion;

    @Schema(description = "Owner 语言的处理结果说明；仅在状态为 FAILED 时出现", example = "验证没有通过，可以查看要求后重新提交需求。")
    private String failureReason;

    @Schema(description = "粗粒度执行阶段；刻意不含工具名、会话或容器信息", example = "NORMALIZING")
    private PlatformProgressStage progressStage;

    @Schema(description = "当前 Requirement 标识；尚未提交时为空", example = "460017668615995393")
    private String requirementId;

    @Schema(description = "当前 Task 标识；尚未归一化时为空", example = "460017668615995394")
    private String taskId;

    @Schema(description = "当前受控 Run 标识；尚未启动执行时为空", example = "run-1f0c2f2a-2f1a-4a3e-9a0f-2f7c1d3b5e64")
    private String runId;

    @Schema(description = "Application 是否已归档；归档后本投影变为只读事实", example = "false")
    private boolean archived;

    @Schema(description = "该投影最后变化时间")
    private LocalDateTime updatedAt;
}
