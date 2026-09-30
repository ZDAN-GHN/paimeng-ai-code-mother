package com.zdan.paimengaicodebackend.platform.deployment;


/**
 * 部署执行的受控失败（Issue #81 / T-09）
 *
 * <p>携带一个白名单 {@link PlatformDeploymentReasonCode} 而不是让 Docker 异常的文本流向状态
 * 投影：原始信息进日志，对外只有一个可枚举的原因码。
 */
public class PlatformDeploymentFailureException extends RuntimeException {

    private final PlatformDeploymentReasonCode reasonCode;

    public PlatformDeploymentFailureException(PlatformDeploymentReasonCode reasonCode, String message) {
        super(message);
        this.reasonCode = reasonCode;
    }

    public PlatformDeploymentFailureException(PlatformDeploymentReasonCode reasonCode, String message,
                                             Throwable cause) {
        super(message, cause);
        this.reasonCode = reasonCode;
    }

    public PlatformDeploymentReasonCode reasonCode() {
        return reasonCode;
    }
}