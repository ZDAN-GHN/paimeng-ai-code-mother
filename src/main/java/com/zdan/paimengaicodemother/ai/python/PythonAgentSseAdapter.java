package com.zdan.paimengaicodemother.ai.python;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.core.handler.JsonMessageStreamHandler;
import com.zdan.paimengaicodemother.core.handler.SimpleTextStreamHandler;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

/**
 * Python Agent SSE 事件分流适配（T15）
 * 复用现有 handler，把 Python §1.3 事件流映射为浏览器显示文本流（§1.6）：
 * - vue_project（buildType=NPM）→ JsonMessageStreamHandler（工具去重 + ToolManager 展示重组）
 * - html / multi_file（buildType=NONE）→ SimpleTextStreamHandler（纯文本透传）
 * - error 事件不进入业务展示流（由调用方触发 failed 终端）
 *
 * @author LXH
 */
@Slf4j
@Component
public class PythonAgentSseAdapter {

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
    public PythonAgentSseAdapter(JsonMessageStreamHandler jsonMessageStreamHandler,
                                 SimpleTextStreamHandler simpleTextStreamHandler) {
        this.jsonMessageStreamHandler = jsonMessageStreamHandler;
        this.simpleTextStreamHandler = simpleTextStreamHandler;
    }

    /**
     * 把 Python SSE 事件流分流为浏览器显示文本流
     *
     * @param pythonSse          Python 主通道事件流
     * @param codeGenType        代码生成类型
     * @param chatHistoryService 聊天历史服务
     * @param appId              应用 id
     * @param loginUser          当前登录用户
     * @return 浏览器显示文本流
     */
    public Flux<String> adapt(Flux<PythonAgentClient.SseEvent> pythonSse,
                              CodeGenTypeEnum codeGenType,
                              ChatHistoryService chatHistoryService,
                              long appId, User loginUser) {
        // error 事件不进入业务展示流（由调用方负责 failed 终端）
        Flux<String> dataFlux = pythonSse
                .filter(event -> !ERROR_EVENT.equals(event.event()))
                .map(PythonAgentClient.SseEvent::data);
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
