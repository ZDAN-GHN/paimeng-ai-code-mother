package com.zdan.paimengaicodebackend.platform.dto;

import io.swagger.v3.oas.annotations.media.Schema;
import java.io.Serial;
import java.io.Serializable;
import lombok.Data;

/**
 * Owner 请求重试（Issue #80 / Slice 2）
 *
 * <p>只有 {@code reason} 一个可选字段。契约刻意不提供基线、验收目标或 Requirement 相关
 * 的入参：D-06 规定这些一旦要改就必须新建 Requirement/Task，把它们放进重试请求等于
 * 给「顺手改目标」留下入口。
 */
@Data
@Schema(description = "Owner 重试请求")
public class PlatformTaskRetryRequest implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Schema(description = "重试理由；仅作审计记录，不参与任何判定", example = "验收目标需要按我补充的规则重跑一次")
    private String reason;

    @Schema(description = "调用方幂等键；为空时 Platform 生成", example = "retry-1f0c2f2a")
    private String requestId;
}
