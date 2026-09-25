package com.zdan.paimengaicodebackend.platform.vo;

import io.swagger.v3.oas.annotations.media.Schema;
import lombok.Data;

/**
 * Lease 授予结果：写入权 + 该写入权对应的真实执行环境能力。
 *
 * <p>两者一起返回是刻意的：Runtime 取得写入权的同时就知道环境能做什么，不必再猜或另发一次
 * 请求（AD-016：能力事实只有 Platform 掌握）。
 */
@Data
@Schema(description = "Lease 授予结果（含执行环境能力）")
public class PlatformRunLeaseGrantVO {

    @Schema(description = "已授予的写入 Lease")
    private PlatformRunLeaseVO lease;

    @Schema(description = "受控执行环境能力")
    private PlatformExecutionCapabilitiesVO capabilities;

    @Schema(description = "Task 冻结基线 JSON，由 Platform 校验后原样交给 Runtime 解析")
    private String baselineJson;
}
