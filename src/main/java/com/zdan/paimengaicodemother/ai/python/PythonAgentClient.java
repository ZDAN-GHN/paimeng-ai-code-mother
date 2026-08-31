package com.zdan.paimengaicodemother.ai.python;

import com.zdan.paimengaicodemother.config.PythonAgentProperties;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;

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
     * 构造 WebClient（base-url、Bearer 令牌、超时均取自配置）
     *
     * @param properties python-agent 配置
     */
    public PythonAgentClient(PythonAgentProperties properties) {
        this.properties = properties;
        this.webClient = WebClient.builder()
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
     * 调用主通道流式接口（阶段 3 完成接入，当前仅占位）
     *
     * @param request 主通道请求体
     * @return Python Agent SSE 事件流
     */
    public Flux<String> stream(PythonAgentRequest request) {
        // 阶段 3 前不可调用：给出明确错误而非 NotImplemented，便于尽早暴露误配置
        throw new BusinessException(ErrorCode.SYSTEM_ERROR, "Python Agent 链路尚未接入完成，请保持 python-agent.enabled=false");
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
