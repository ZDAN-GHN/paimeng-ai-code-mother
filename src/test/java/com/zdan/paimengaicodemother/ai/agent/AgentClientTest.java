package com.zdan.paimengaicodemother.ai.agent;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.zdan.paimengaicodemother.exception.BusinessException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * AgentClient 单元测试（不依赖 Spring 上下文与数据库）
 * 用 JDK HttpServer 模拟 Agent 的 SSE 主通道与健康检查
 *
 * @author LXH
 */
class AgentClientTest {

    private HttpServer server;
    private String baseUrl;
    private List<String> authorizationHeaders;

    /**
     * 启动模拟 Agent 的 HTTP 服务（随机端口）
     */
    @BeforeEach
    void setUp() throws IOException {
        authorizationHeaders = new ArrayList<>();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/agent/stream", this::handleStream);
        server.createContext("/healthz", this::handleHealth);
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /**
     * 停止模拟服务
     */
    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    private void handleStream(HttpExchange exchange) throws IOException {
        authorizationHeaders.add(exchange.getRequestHeaders().getFirst("Authorization"));
        byte[] body = ("data: {\"type\":\"ai_response\",\"data\":\"hi\"}\n\n"
                + "event: error\n"
                + "data: {\"message\":\"boom\"}\n\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "text/event-stream;charset=UTF-8");
        // 0 表示 chunked（SSE 流式），不设置 Content-Length
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(body);
        }
    }

    private void handleHealth(HttpExchange exchange) throws IOException {
        byte[] body = "{\"status\":\"ok\"}".getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(body);
        }
    }

    private AgentClient newClient(boolean enabled) {
        AgentProperties properties = new AgentProperties();
        properties.setEnabled(enabled);
        properties.setBaseUrl(baseUrl);
        properties.setToken("test-token");
        properties.setConnectTimeoutMs(3000);
        properties.setReadTimeoutMs(5000);
        return new AgentClient(properties);
    }

    private AgentRequest newRequest() {
        AgentRequest request = new AgentRequest();
        request.setAppId(1L);
        request.setUserId(10001L);
        request.setMessage("做一个红包雨页面");
        request.setCodeGenType("html");
        request.setRunId("run-1");
        request.setThreadId("app:1");
        request.setWorkspacePath("/tmp/ws/html_1");
        return request;
    }

    /**
     * 主通道 SSE 解码：普通事件与 error 事件（event 名 + data 载荷）
     */
    @Test
    void streamDecodesSseEvents() {
        AgentClient client = newClient(true);
        List<AgentClient.SseEvent> events = new ArrayList<>();
        client.stream(newRequest()).doOnNext(events::add).blockLast();
        assertEquals(2, events.size());
        // 普通事件：event 为空，data 为语义载荷
        assertNull(events.get(0).event());
        assertEquals("{\"type\":\"ai_response\",\"data\":\"hi\"}", events.get(0).data());
        // 错误事件：event=error，data 为错误消息
        assertEquals("error", events.get(1).event());
        assertEquals("{\"message\":\"boom\"}", events.get(1).data());
    }

    /**
     * 主通道请求携带 Bearer 令牌（§1.1 鉴权）
     */
    @Test
    void streamSendsBearerToken() {
        AgentClient client = newClient(true);
        client.stream(newRequest()).blockLast();
        assertEquals(List.of("Bearer test-token"), authorizationHeaders);
    }

    /**
     * 未启用时调用主通道抛明确 BusinessException（早暴露误配置）
     */
    @Test
    void streamThrowsWhenDisabled() {
        AgentClient client = newClient(false);
        assertThrows(BusinessException.class, () -> client.stream(newRequest()).blockLast());
    }

    /**
     * 健康检查：存活返回 true
     */
    @Test
    void healthOk() {
        AgentClient client = newClient(true);
        assertTrue(client.health());
    }

    /**
     * 健康检查：服务不可达返回 false（不抛异常）
     */
    @Test
    void healthDownReturnsFalse() {
        AgentProperties properties = new AgentProperties();
        properties.setEnabled(true);
        properties.setBaseUrl("http://127.0.0.1:1");
        properties.setToken("test-token");
        properties.setConnectTimeoutMs(500);
        properties.setReadTimeoutMs(500);
        AgentClient client = new AgentClient(properties);
        assertFalse(client.health());
    }
}
