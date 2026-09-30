package com.zdan.paimengaicodebackend.platform.domain;

/**
 * Owner 通过 Product Layer 能看到的执行状态（Issue #80 / T-08）
 * <p>
 * 这是 Platform 领域状态到 Owner 语言的一次投影，不是新的状态机：每个取值都能追溯到
 * D-06 的 Task/Run 状态或尚未归一化这一事实。刻意不包含 Pi Session、工具细节、
 * Sandbox 标识、Snapshot 提交哈希和任何生产信息——那些只存在于 Platform 内部证据链。
 */
public enum PlatformOwnerVisibleStatus {

    /** Requirement 已接收，Platform 尚未冻结可执行基线。 */
    AWAITING_NORMALIZATION("需求已接收，正在整理成可执行的开发目标"),
    /** 基线已冻结，Task 可被受控 Run 执行。 */
    READY("已整理完成，等待开始构建"),
    /** Run 已获得写入权并正在受控执行。 */
    EXECUTING("正在构建你的 Application"),
    /** 存在唯一决定性业务问题，等待 Owner 答复。 */
    BLOCKED("需要你确认一个业务问题"),
    /** Run、Validation 或安全失败，基线保留。 */
    FAILED("构建未通过验证"),
    /** 同一 Snapshot 的必需验证全部通过。 */
    VALIDATED("验证已通过"),
    /** 已创建固定 Release（发布确认与部署由 T-09 表达）。 */
    RELEASED("已发布固定版本"),
    /** Owner 或 System Administrator 已取消。 */
    CANCELLED("已取消");

    private final String headline;

    PlatformOwnerVisibleStatus(String headline) {
        this.headline = headline;
    }

    /** Owner 语言的当前状态说明；不含任何内部标识或执行细节。 */
    public String headline() {
        return headline;
    }
}
