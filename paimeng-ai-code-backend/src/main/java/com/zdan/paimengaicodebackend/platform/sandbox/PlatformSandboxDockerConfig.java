package com.zdan.paimengaicodebackend.platform.sandbox;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.github.dockerjava.transport.DockerHttpClient;
import java.time.Duration;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Sandbox 执行器的 Docker 客户端装配（Issue #77 / T-05）。
 *
 * <p>只有 {@code platform.sandbox.enabled=true} 时才创建 {@link DockerClient}。AD-016 要求
 * Docker API 由 Platform 受控执行器独占，关闭时进程内不应存在可用的 Docker 客户端。
 *
 * <p>{@code DockerClient} 实现 {@link java.io.Closeable}，容器销毁时由 Spring 关闭。
 */
@Slf4j
@Configuration
@ConditionalOnProperty(prefix = "platform.sandbox", name = "enabled", havingValue = "true")
public class PlatformSandboxDockerConfig {

    @Bean
    public DockerClient platformSandboxDockerClient(PlatformSandboxProperties properties) {
        DefaultDockerClientConfig.Builder configBuilder =
            DefaultDockerClientConfig.createDefaultConfigBuilder();
        if (!properties.getDockerHost().isBlank()) {
            configBuilder.withDockerHost(properties.getDockerHost());
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

        log.info(
            "Platform Sandbox docker client initialized, dockerHost: {}, image: {}",
            clientConfig.getDockerHost(),
            properties.getImageReference()
        );
        return DockerClientImpl.getInstance(clientConfig, httpClient);
    }
}
