package com.zdan.paimengaicodebackend.platform.docker;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * Platform 受控执行器共用的 Docker 连接配置（Issue #81 / T-09）
 *
 * <p>抽到独立于 Sandbox 的原因是 AD-016：Docker API 由 Platform 受控执行器独占，而受控执行器
 * 现在有两条——受控 Run 的 Sandbox 与 Release 的 Deployment。把 Docker 主机配置留在
 * {@code platform.sandbox.*} 下会让「部署生产容器」依赖一个与生产无关的命名空间，
 * 迟早有人为了部署去打开 Sandbox 开关。
 */
@Data
@Component
@ConfigurationProperties(prefix = "platform.docker")
public class PlatformDockerProperties {

    /** Docker Engine 地址。留空则走 docker-java 默认发现（DOCKER_HOST 或本机 socket）。 */
    private String host = "";
}