package com.zdan.paimengaicodebackend.platform.deployment;

/**
 * 部署的受控诊断阶段（Issue #81 / T-09）
 *
 * <p>AD-017 与本 Issue 的「受控诊断不含敏感配置」验收项要求失败时不泄露容器、版本、日志或
 * 基础设施细节，因此这里只允许固定枚举值。{@link #ownerText()} 是唯一允许外发的说明，任何
 * 新增取值都必须先给出不含内部标识的 Owner 语言。
 */
public enum PlatformDeploymentStage {

    /** Release 已固定，等待部署。 */
    RELEASED("已创建固定版本，等待上线"),
    /** 正在准备运行环境。 */
    PROVISIONING("正在准备上线"),
    /** 内部健康检查已完成。 */
    HEALTH_PROBED("已完成上线前检查"),
    /** 已在公开路径运行。 */
    HEALTHY("已上线，可通过公开地址访问"),
    /** 未通过健康检查，保持未上线。 */
    UNHEALTHY("上线未成功，应用暂未对外开放");

    private final String ownerText;

    PlatformDeploymentStage(String ownerText) {
        this.ownerText = ownerText;
    }

    public String ownerText() {
        return ownerText;
    }
}