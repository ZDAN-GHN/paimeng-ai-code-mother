package com.zdan.paimengaicodebackend.platform.deployment;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import org.springframework.stereotype.Component;

/**
 * 内部健康探测（Issue #81 / T-09）
 *
 * <p>AD-017：健康探测只经内部 Deployment network 调用应用自身的 {@code GET /healthz}，
 * 不经过公开路径、不经过宿主机端口。之所以从 Platform 进程发起而不是在容器内 exec 一条命令，
 * 是因为探测方式不能依赖目标运行时里恰好装了某个可执行文件。
 *
 * <p>结论只有三态（成功 / 失败 / 超时），响应体一律丢弃：把应用响应体带进日志或状态投影
 * 就等于把不受控内容泄漏出去。
 */
@Component
public class PlatformDeploymentHealthProbe {

    /** 一次探测的结论。刻意不携带响应体、响应头或任何目标侧内容。 */
    public enum Outcome {
        HEALTHY,
        FAILED,
        TIMED_OUT
    }

    private final HttpClient client;
    private final String healthPath;
    private final int requestTimeoutSeconds;

    public PlatformDeploymentHealthProbe(PlatformDeploymentProperties properties) {
        this.client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(Math.max(1, properties.getProbeConnectTimeoutSeconds())))
            // 重定向与代理都关闭：应用若返回 302，说明它的健康端点本身有问题，
            // 跟随跳转会把探测变成对另一个地址的请求。
            .followRedirects(HttpClient.Redirect.NEVER)
            .proxy(HttpClient.Builder.NO_PROXY)
            .build();
        this.healthPath = normalizeHealthPath(properties.getHealthPath());
        this.requestTimeoutSeconds = Math.max(1, properties.getProbeRequestTimeoutSeconds());
    }

    /**
     * 探测一个已启动容器的健康端点。
     *
     * @param host 容器在内部 Deployment network 上的地址
     * @param port 容器内监听端口（AD-016：不发布宿主机端口）
     */
    public Outcome probe(String host, int port) {
        if (host == null || host.isBlank() || port <= 0 || port > 65535) {
            return Outcome.FAILED;
        }
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create("http://" + host + ":" + port + healthPath))
            .timeout(Duration.ofSeconds(requestTimeoutSeconds))
            .GET()
            .build();
        try {
            HttpResponse<Void> response = client.send(request, HttpResponse.BodyHandlers.discarding());
            int status = response.statusCode();
            return status >= 200 && status < 300 ? Outcome.HEALTHY : Outcome.FAILED;
        } catch (HttpTimeoutException timeout) {
            return Outcome.TIMED_OUT;
        } catch (IOException unreachable) {
            // 连接被拒与路由不可达都归为「探测失败」，不外发具体异常类型。
            return Outcome.FAILED;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Outcome.TIMED_OUT;
        }
    }

    private static String normalizeHealthPath(String configured) {
        if (configured == null || configured.isBlank() || !configured.startsWith("/")
            || configured.contains("..") || configured.contains("//")) {
            return "/healthz";
        }
        return configured;
    }
}