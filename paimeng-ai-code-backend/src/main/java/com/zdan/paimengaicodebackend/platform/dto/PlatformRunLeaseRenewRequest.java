package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "续租 Run 写入 Lease 请求")
public class PlatformRunLeaseRenewRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -7215884401963320551L;

    @Schema(
        description = "Application 标识；以十进制字符串传输。服务端校验 runId 确实归属该 Application",
        example = "460017668615995392"
    )
    private String applicationId;

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(
        description = "持有者的 fence token。落后于当前 Lease 即被拒绝",
        example = "7"
    )
    private Long fenceToken;

    @Schema(description = "续租原因码，落入审计事件", example = "RUNTIME_HEARTBEAT")
    private String reasonCode;

    @Schema(description = "幂等键。同一 requestId 重放返回首次结果而非报错", example = "req-8f2c1d91")
    private String requestId;
}
