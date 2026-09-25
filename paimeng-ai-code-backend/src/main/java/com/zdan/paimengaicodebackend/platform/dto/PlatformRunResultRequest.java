package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "上报 Run 执行结果请求")
public class PlatformRunResultRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 8815604417238190663L;

    @Schema(
        description = "Application 标识；以十进制字符串传输。服务端校验 runId 确实归属该 Application",
        example = "460017668615995392"
    )
    private String applicationId;

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(description = "持有者的 fence token。落后于当前 Lease 即被拒绝", example = "7")
    private Long fenceToken;

    @Schema(
        description = "Run 终态，取值 SUCCEEDED / FAILED / CANCELLED",
        example = "SUCCEEDED"
    )
    private String outcome;

    @Schema(description = "终态原因码，落入转换事件", example = "RUNTIME_REPORTED_SUCCESS")
    private String reasonCode;

    @Schema(description = "证据引用，落入转换事件", example = "run-20260925-0001/events")
    private String evidenceRef;

    @Schema(description = "幂等键", example = "req-8f2c1d94")
    private String requestId;
}
