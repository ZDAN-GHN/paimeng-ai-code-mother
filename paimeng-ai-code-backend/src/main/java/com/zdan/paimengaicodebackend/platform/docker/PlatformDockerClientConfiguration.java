package com.zdan.paimengaicodebackend.platform.docker;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.github.dockerjava.transport.DockerHttpClient;
import java.time.Duration;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Platform 受控执行器的 Docker 客户端装配（Issue #81 / T-09）
 *
 * <p>进程内只允许存在一个 {@link DockerClient}：AD-016 要求 Docker API 由 Platform 受控执行器
 * 独占，而 Sandbox 与 Deployment 都是这样的执行器。两个开关任一开启才创建客户端——都关闭时
 * 进程内不应存在可用的 Docker 客户端，因此本类不使用 Sandbox 的配置对象。
 *
 * <p>{@code DockerClient} 实现 {@link java.io.Closeable}，容器销毁时由 Spring 关闭。
 */
@Slf4j
@Configuration
@ConditionalOnExpression("${platform.sandbox.enabled:false} or ${platform.deployment.enabled:false}")
public class PlatformDockerClientConfiguration {

    @Bean
    public DockerClient platformDockerClient(PlatformDockerProperties properties) {
        DefaultDockerClientConfig.Builder configBuilder =
            DefaultDockerClientConfig.createDefaultConfigBuilder();
        if (!properties.getHost().isBlank()) {
            configBuilder.withDockerHost(properties.getHost());
        }
        DockerClientConfig clientConfig = configBuilder.build();

        // 跨服务调用须设明确超时（.agents/rules/errors.md）。responseTimeout 不能覆盖
        // exec 的长连接流式读取，docker-java 对 attach 类请求不套用该超时。
        DockerHttpClient httpClient = new ApacheDockerHttpClient.Builder()
            .dockerHost(clientConfig.getDockerHost())
            .sslConfig(clientConfig.getSSLConfig())
            .maxConnections(50)
            .connectionTimeout(Duration.ofSeconds(10))
            .responseTimeout(Duration.ofSeconds(45))
            .build();

        log.info("Platform docker client initialized, dockerHost: {}", clientConfig.getDockerHost());
        return DockerClientImpl.getInstance(clientConfig, httpClient);
    }
}