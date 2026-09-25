package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "在 Run 的 Sandbox 内执行命令请求")
public class PlatformRunCommandRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = -4471905523318870142L;

    @Schema(
        description = "Application 标识；以十进制字符串传输。服务端校验 runId 确实归属该 Application",
        example = "460017668615995392"
    )
    private String applicationId;

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(description = "持有者的 fence token。落后于当前 Lease 即被拒绝", example = "7")
    private Long fenceToken;

    @Schema(description = "在容器内执行的命令，工作目录为 /workspace", example = "npm run build")
    private String command;

    @Schema(
        description = "命令超时秒数。缺省取服务端默认值，超过服务端上限即被拒绝",
        example = "120"
    )
    private Integer timeoutSeconds;

    @Schema(description = "幂等键；同时作为日志关联标识", example = "req-8f2c1d93")
    private String requestId;
}
