package com.zdan.paimengaicodebackend.platform.domain;

/**
 * Lease 判据的拒绝原因，落 {@code platform_run_lease_event.reasonCode}。
 *
 * <p>用枚举而非自由字符串：这些值是事后审计的检索键，拼写漂移会让「有多少次过期写入被拒」
 * 这类问题无法回答。
 */
public enum PlatformRunLeaseRejectionReason {

    /** Run 没有活跃 Lease 行——通常是已释放或已被收割后仍有调用方尝试写入。 */
    LEASE_ABSENT,

    /** 出示的 fence token 与当前持有者不符：调用方持的是被取代的旧凭据。 */
    LEASE_FENCE_STALE,

    /** Lease 存在且 fence 匹配，但 TTL 已过。同时用于收割事件的原因码。 */
    LEASE_TTL_ELAPSED
}
