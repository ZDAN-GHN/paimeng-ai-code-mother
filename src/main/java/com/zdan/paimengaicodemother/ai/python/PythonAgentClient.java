package com.zdan.paimengaicodemother.ai.python;

import com.zdan.paimengaicodemother.config.PythonAgentProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import io.netty.channel.ChannelOption;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.netty.http.client.HttpClient;

import java.time.Duration;

/**
 * Python Agent HTTP 客户端
 * 主通道、健康检查、鉴权按 docs/py_agent/task_plan.md §1.1 实现
 *
 * @author LXH
 */
@Component
public class PythonAgentClient {

    /**
     * 主通道路径
     */
    private static final String STREAM_PATH = "/v1/agent/stream";

    /**
     * 健康检查路径
     */
    private static final String HEALTH_PATH = "/healthz";

    private final PythonAgentProperties properties;

    private final WebClient webClient;

    /**
     * 构造 WebClient（base-url、Bearer 令牌、连接/读超时均取自配置）
     *
     * @param properties python-agent 配置
     */
    public PythonAgentClient(PythonAgentProperties properties) {
        this.properties = properties;
        // 连接超时 + 读超时（read-timeout-ms 内既无事件也无回调则判定失败，§1.5）
        HttpClient httpClient = HttpClient.create()
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, (int) properties.getConnectTimeoutMs())
                .responseTimeout(Duration.ofMillis(properties.getReadTimeoutMs()));
        this.webClient = WebClient.builder()
                .clientConnector(new ReactorClientHttpConnector(httpClient))
                .baseUrl(properties.getBaseUrl())
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + properties.getToken())
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.TEXT_EVENT_STREAM_VALUE)
                .build();
    }

    /**
     * 健康检查
     *
     * @return 是否存活
     */
    public boolean health() {
        return Boolean.TRUE.equals(webClient.get()
                .uri(HEALTH_PATH)
                .retrieve()
                .bodyToMono(HealthResponse.class)
                .map(HealthResponse::isOk)
                .onErrorReturn(false)
                .block());
    }

    /**
     * 调用主通道流式接口（§1.1）
     * POST /v1/agent/stream，解码 SSE 事件（event 名 + data 载荷）
     *
     * @param request 主通道请求体（§1.2）
     * @return Python Agent SSE 事件流
     */
    public Flux<SseEvent> stream(PythonAgentRequest request) {
        if (!properties.isEnabled()) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR, "python-agent 未启用，请设置 python-agent.enabled=true");
        }
        return webClient.post()
                .uri(STREAM_PATH)
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(request)
                .retrieve()
                .bodyToFlux(new ParameterizedTypeReference<ServerSentEvent<String>>() {
                })
                // Reactor 解码 SSE 流时可能在流中产生空事件（event/data 均为 null），无语义载荷，过滤掉避免下游空指针
                .filter(sse -> sse.data() != null)
                .map(sse -> new SseEvent(sse.event(), sse.data()));
    }

    /**
     * SSE 事件（event 名 + data 载荷）
     * 正常事件 event 为空、data 为语义载荷；错误事件 event=error、data 为 {"message":...}
     *
     * @param event 事件名（可空）
     * @param data  事件载荷（可空）
     * @author LXH
     */
    public record SseEvent(String event, String data) {
    }

    /**
     * 健康检查响应体
     *
     * @author LXH
     */
    public static class HealthResponse {

        /**
         * 状态
         */
        private String status;

        public boolean isOk() {
            return "ok".equals(status);
        }

        public String getStatus() {
            return status;
        }

        public void setStatus(String status) {
            this.status = status;
        }
    }
}
