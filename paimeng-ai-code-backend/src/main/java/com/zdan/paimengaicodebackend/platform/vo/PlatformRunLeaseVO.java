package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Schema(description = "Run 写入 Lease 视图")
public class PlatformRunLeaseVO {

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(
        description = "Application 标识；以十进制字符串传输，避免 JavaScript 精度丢失",
        example = "460017668615995392"
    )
    private String applicationId;

    @Schema(
        description = "Task 标识；以十进制字符串传输，避免 JavaScript 精度丢失",
        example = "460017668615995393"
    )
    private String taskId;

    @Schema(
        description = "fence token。Application 内单调递增的小计数器，不是雪花 ID，"
            + "但 JsonConfig 对 long 注册了全局 ToStringSerializer，因此线上仍是十进制字符串；"
            + "持有者每次写操作都须原样回传。线上格式由 PlatformExecutionWireFormatTest 钉死",
        example = "7",
        type = "string"
    )
    private long fenceToken;

    @Schema(description = "授予时间")
    private LocalDateTime grantedAt;

    @Schema(description = "过期时间。超过该时刻的写入一律被拒")
    private LocalDateTime expiresAt;

    @Schema(description = "已续租次数", example = "0")
    private int renewCount;
}
