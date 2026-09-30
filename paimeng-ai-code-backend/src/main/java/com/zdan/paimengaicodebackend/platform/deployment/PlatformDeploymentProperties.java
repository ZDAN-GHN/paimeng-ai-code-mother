package com.zdan.paimengaicodebackend.platform.deployment;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 受控部署配置（Issue #81 / T-09）
 *
 * <p>AD-017：公开路径前缀与运行端口属于部署环境配置，不在代码或 Application 配置里硬编码。
 * 这里不提供任何密钥字段——注入生产密钥是 Platform 的职责，但 MVP 切片不实现它，
 * 留一个空配置位比留一个会被人随手填写的字符串安全。
 */
@Data
@Component
@ConfigurationProperties(prefix = "platform.deployment")
public class PlatformDeploymentProperties {

    /** 部署总开关。默认关闭：Platform 未显式开启部署能力时不得创建任何生产容器。 */
    private boolean enabled = false;

    /**
     * 固定 Release 钉住的运行时契约名。它决定用哪套镜像、启动命令与健康路径，
     * 因此 Release 一旦创建就固定记录这个名字，事后改配置不会静默改变已发布版本的含义。
     */
    private String runtimeProfile = "NODE_20";

    /** 运行时镜像；执行器不联网拉取，镜像缺失时快速失败并给出构建命令。 */
    private String imageReference = "paimeng-application-runtime:0.1.0";

    /**
     * 容器内监听端口。AD-016 要求 Deployment 不发布宿主机端口，因此它只用于容器内健康探测
     * 与内部网络寻址。
     */
    private int internalPort = 8123;

    /** 容器内健康路径。AD-017 固定为应用自身的 {@code GET /healthz}。 */
    private String healthPath = "/healthz";

    /** Platform 独占的内部 Deployment network；容器只加入这一个网络。 */
    private String networkName = "paimeng-platform-deploy";

    /** 公开路径前缀（AD-017：Platform 既有域名下的 {@code /apps/<application-id>/}）。 */
    private String publicBasePath = "/apps";

    /** 单次健康探测的连接超时（秒）。 */
    private int probeConnectTimeoutSeconds = 2;

    /** 单次健康探测的响应超时（秒）。 */
    private int probeRequestTimeoutSeconds = 5;

    /** 部署就绪前的重试间隔（毫秒）。 */
    private long probeRetryIntervalMs = 2000L;

    /** 从领取到判定健康的最长等待时间（秒）。超时按未健康处理，不无限等待。 */
    private int readinessDeadlineSeconds = 120;

    /** PROVISIONING 僵死回收阈值（秒）。Platform 被终止后据此重新排期。 */
    private int staleProvisioningSeconds = 600;

    /** 轮询间隔（毫秒）。只影响排队快慢，不改变任何状态语义。 */
    private long pollIntervalMs = 5000L;

    /** 公开转发允许的最大响应体字节数；超限按网关错误处理，不做无上限缓冲。 */
    private int maxProxiedResponseBytes = 8 * 1024 * 1024;

    /** 公开转发的上游超时（秒）。 */
    private int proxyTimeoutSeconds = 30;

    /** 与 AD-016 的 Sandbox 同源的容器限额。 */
    private long memoryLimitMb = 2048L;

    private double cpuLimit = 1.0d;

    private long pidsLimit = 128L;
}