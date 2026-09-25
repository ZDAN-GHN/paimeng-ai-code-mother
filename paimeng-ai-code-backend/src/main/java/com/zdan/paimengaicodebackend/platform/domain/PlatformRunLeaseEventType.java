package com.zdan.paimengaicodebackend.platform.domain;

/**
 * Lease 审计事件类型。持久化为 {@code platform_run_lease_event.eventType}
 * （{@code VARCHAR(32)}，无 CHECK 约束，新增取值不需要迁移）。
 */
public enum PlatformRunLeaseEventType {
    GRANTED,
    RENEWED,
    RELEASED,
    EXPIRED,

    /**
     * 被拒绝的写入尝试。前四种记录 Lease 生命周期，本项记录<strong>未获授权的尝试</strong>：
     * 谁拿着哪个凭据试图写入、为何被拒。缺了它，「Lease 已被释放后仍有人尝试写入」这类事实
     * 在事后无法解释（{@code engineering-quality.md}：重要流程应能在事后解释发生了什么）。
     */
    REJECTED
}
