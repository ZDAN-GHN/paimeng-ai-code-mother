package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

@Data
@Schema(description = "Sandbox 内命令执行结果")
public class PlatformRunCommandResultVO {

    @Schema(description = "Run 标识", example = "run-20260925-0001")
    private String runId;

    @Schema(
        description = "命令退出码。非零是命令的正常结果并原样返回；信号终止报 128 + signal",
        example = "0"
    )
    private int exitCode;

    @Schema(description = "标准输出")
    private String stdout;

    @Schema(description = "标准错误")
    private String stderr;

    @Schema(description = "执行耗时毫秒", example = "184")
    private long durationMs;
}
