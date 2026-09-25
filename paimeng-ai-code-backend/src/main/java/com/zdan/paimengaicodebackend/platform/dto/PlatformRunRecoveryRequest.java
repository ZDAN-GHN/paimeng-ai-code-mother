package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

@Data
@Schema(description = "Run 请求前恢复检查点操作")
public class PlatformRunRecoveryRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    private String applicationId;

    private String runId;

    private Long fenceToken;

    private String requestId;
}
