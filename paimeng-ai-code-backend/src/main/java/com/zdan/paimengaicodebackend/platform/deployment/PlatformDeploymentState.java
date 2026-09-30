package com.zdan.paimengaicodebackend.platform.deployment;

/**
 * 部署的权威状态（Issue #81 / T-09）
 *
 * <p>AD-010：Production 的实际状态由「当前健康 Deployment 所引 Release」表达，而不是 Task 状态。
 * 因此 {@link #HEALTHY} 是「已上线」的唯一事实来源；Task 处于 {@code RELEASED} 只说明固定版本
 * 已创建，不代表线上有东西在跑。
 */
public enum PlatformDeploymentState {

    /** Release 已固定，等待 Platform 受控执行器领取。 */
    PENDING,
    /** 已被领取，正在创建容器并执行内部健康检查。 */
    PROVISIONING,
    /** 内部健康检查通过，允许挂载公开路径。 */
    HEALTHY,
    /** 未通过健康检查；不存在健康公开路径，应用保持未上线。 */
    UNHEALTHY
}