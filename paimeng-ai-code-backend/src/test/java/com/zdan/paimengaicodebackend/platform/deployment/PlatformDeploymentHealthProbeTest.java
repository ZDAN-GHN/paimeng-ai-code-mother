package com.zdan.paimengaicodebackend.platform.deployment;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * 内部健康探测（Issue #81 / T-09；AD-017）
 *
 * <p>用真实回环 HTTP 服务验证三态判定，避免只测 mock 转发而漏掉「连接被拒」「超时」
 * 这两类在隔离环境里最常见的失败。探测结论刻意只有三态且不含任何响应内容。
 */
class PlatformDeploymentHealthProbeTest {

    private HttpServer server;
    private PlatformDeploymentProperties properties;

    @BeforeEach
    void setUp() throws IOException {
        properties = new PlatformDeploymentProperties();
        properties.setProbeRequestTimeoutSeconds(1);
        properties.setProbeConnectTimeoutSeconds(1);
    }

    @AfterEach
    void tearDown() {
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void successfulHealthEndpointIsHealthy() throws IOException {
        int port = serve(200, "ok");

        assertEquals(PlatformDeploymentHealthProbe.Outcome.HEALTHY,
            new PlatformDeploymentHealthProbe(properties).probe("127.0.0.1", port));
    }

    @Test
    void failingHealthEndpointIsNotHealthy() throws IOException {
        int port = serve(503, "starting");

        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED,
            new PlatformDeploymentHealthProbe(properties).probe("127.0.0.1", port));
    }

    @Test
    void redirectIsNotFollowedBecauseItWouldProbeAnotherAddress() throws IOException {
        int port = serve(302, "");

        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED,
            new PlatformDeploymentHealthProbe(properties).probe("127.0.0.1", port));
    }

    @Test
    void unreachablePortIsAFailedProbeNotAnException() throws IOException {
        int closedPort = freePort();

        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED,
            new PlatformDeploymentHealthProbe(properties).probe("127.0.0.1", closedPort));
    }

    @Test
    void silentServerIsReportedAsTimeout() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newSingleThreadExecutor());
        server.createContext("/healthz", exchange -> {
            try {
                Thread.sleep(3_000L);
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().close();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } catch (IOException closed) {
                exchange.close();
            }
        });
        server.start();

        assertEquals(PlatformDeploymentHealthProbe.Outcome.TIMED_OUT,
            new PlatformDeploymentHealthProbe(properties).probe("127.0.0.1", server.getAddress().getPort()));
    }

    @Test
    void invalidTargetIsRejectedBeforeAnyNetworkCall() {
        PlatformDeploymentHealthProbe probe = new PlatformDeploymentHealthProbe(properties);

        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED, probe.probe(null, 8123));
        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED, probe.probe("  ", 8123));
        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED, probe.probe("127.0.0.1", 0));
        assertEquals(PlatformDeploymentHealthProbe.Outcome.FAILED, probe.probe("127.0.0.1", 70_000));
    }

    private int serve(int status, String body) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/healthz", exchange -> {
            byte[] payload = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, payload.length);
            try (var out = exchange.getResponseBody()) {
                out.write(payload);
            }
        });
        server.start();
        return server.getAddress().getPort();
    }

    private int freePort() throws IOException {
        try (java.net.ServerSocket socket = new java.net.ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }
}