package com.zdan.paimengaicodebackend.platform.deployment;

import java.util.Locale;

/**
 * 部署失败的受控原因码（Issue #81 / T-09）
 *
 * <p>白名单式设计的原因：受控诊断要能解释「为什么没上线」，又不能泄露配置、命令输出或
 * 基础设施细节。原始异常只进日志，这里只留一个可枚举的码。
 * {@link #of(String)} 对未登记值返回 {@code null} 而不是原样透传，避免旧行或被篡改的值
 * 直接进入对外投影。
 */
public enum PlatformDeploymentReasonCode {

    /** 运行镜像不存在；执行器不联网拉镜像。 */
    RUNTIME_IMAGE_UNAVAILABLE,
    /** 容器创建或启动失败。 */
    CONTAINER_START_FAILED,
    /** 容器已启动但拿不到内部 Deployment network 地址。 */
    CONTAINER_ADDRESS_UNAVAILABLE,
    /** 健康端点返回非成功状态。 */
    HEALTH_PROBE_FAILED,
    /** 在规定窗口内没有得到成功响应。 */
    HEALTH_PROBE_TIMEOUT,
    /** Platform 缺少启动该应用必需的运行时配置（如托管数据库连接串）。 */
    RUNTIME_CONFIGURATION_MISSING,
    /** Application 已归档或已逻辑删除，不再具备上线条件。 */
    APPLICATION_NOT_ACTIVE;

    public static PlatformDeploymentReasonCode of(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return valueOf(raw.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException unregistered) {
            return null;
        }
    }

    /** Owner 语言说明；不含基础设施细节。 */
    public String ownerText() {
        return switch (this) {
            case RUNTIME_IMAGE_UNAVAILABLE -> "运行环境尚未就绪";
            case CONTAINER_START_FAILED -> "运行环境没有成功启动";
            case CONTAINER_ADDRESS_UNAVAILABLE -> "运行环境没有成功就绪";
            case HEALTH_PROBE_FAILED -> "应用没有通过上线前检查";
            case HEALTH_PROBE_TIMEOUT -> "上线前检查没有在规定时间内完成";
            case RUNTIME_CONFIGURATION_MISSING -> "运行环境配置尚未就绪";
            case APPLICATION_NOT_ACTIVE -> "该应用当前不接受上线";
        };
    }
}