package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "释放 Run 写入 Lease 请求")
public class PlatformRunLeaseReleaseRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 5098431227760143398L;

    @Schema(
        description = "Application 标识；以十进制字符串传输。服务端校验 runId 确实归属该 Application",
        example = "460017668615995392"
    )
    private String applicationId;

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(description = "持有者的 fence token。落后于当前 Lease 即被拒绝", example = "7")
    private Long fenceToken;

    @Schema(description = "释放原因码，落入审计事件", example = "RUNTIME_COMPLETED")
    private String reasonCode;

    @Schema(description = "幂等键。同一 requestId 重放视为成功", example = "req-8f2c1d92")
    private String requestId;
}
