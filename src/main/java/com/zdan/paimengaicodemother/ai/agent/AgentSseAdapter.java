package com.zdan.paimengaicodemother.ai.agent;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.core.handler.JsonMessageStreamHandler;
import com.zdan.paimengaicodemother.core.handler.SimpleTextStreamHandler;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

/**
 * Agent SSE 事件分流适配（泛化自 PythonAgentSseAdapter，Issue #6）
 * 复用现有 handler，把 §1.3 事件流映射为浏览器显示文本流（§1.6）：
 * - vue_project（buildType=NPM）→ JsonMessageStreamHandler（工具去重 + ToolManager 展示重组）
 * - html / multi_file（buildType=NONE）→ SimpleTextStreamHandler（纯文本透传）
 * - error 事件不进入业务展示流（由调用方触发 failed 终端）
 *
 * @author LXH
 */
@Slf4j
@Component
public class AgentSseAdapter {

    /**
     * 错误事件名（§1.3）
     */
    private static final String ERROR_EVENT = "error";

    private final JsonMessageStreamHandler jsonMessageStreamHandler;
    private final SimpleTextStreamHandler simpleTextStreamHandler;

    /**
     * 注入现有 handler
     *
     * @param jsonMessageStreamHandler vue 工程消息处理器
     * @param simpleTextStreamHandler  纯文本流处理器
     */
    public AgentSseAdapter(JsonMessageStreamHandler jsonMessageStreamHandler,
                           SimpleTextStreamHandler simpleTextStreamHandler) {
        this.jsonMessageStreamHandler = jsonMessageStreamHandler;
        this.simpleTextStreamHandler = simpleTextStreamHandler;
    }

    /**
     * 把 Agent SSE 事件流分流为浏览器显示文本流
     *
     * @param agentSse          主通道事件流
     * @param codeGenType       代码生成类型
     * @param chatHistoryService 聊天历史服务
     * @param appId             应用 id
     * @param loginUser         当前登录用户
     * @return 浏览器显示文本流
     */
    public Flux<String> adapt(Flux<AgentClient.SseEvent> agentSse,
                              CodeGenTypeEnum codeGenType,
                              ChatHistoryService chatHistoryService,
                              long appId, User loginUser) {
        // error 事件不进入业务展示流（由调用方负责 failed 终端）；
        // 过滤 data 为 null 的事件：Reactor 对 SSE 流解码时可能在流中产生空事件（data=null，无 event/id/comment），
        // 该事件无语义载荷，直接跳过可避免下游 map 因 null 中断整条流
        Flux<String> dataFlux = agentSse
                .filter(event -> event.data() != null)
                .filter(event -> !ERROR_EVENT.equals(event.event()))
                .map(AgentClient.SseEvent::data);
        return switch (codeGenType.getBuildType()) {
            case NPM -> jsonMessageStreamHandler.handle(dataFlux, chatHistoryService, appId, loginUser);
            case NONE -> simpleTextStreamHandler.handle(dataFlux, chatHistoryService, appId, loginUser);
            default -> {
                log.error("不支持的构建类型，codeGenType: {}", codeGenType);
                yield Flux.empty();
            }
        };
    }
}
