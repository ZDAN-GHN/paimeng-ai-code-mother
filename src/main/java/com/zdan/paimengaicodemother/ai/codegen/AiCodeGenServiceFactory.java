package com.zdan.paimengaicodemother.ai.codegen;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.service.AiServices;
import org.springframework.context.annotation.Configuration;

/**
 * ai 代码生成服务创建工厂
 *
 * @author LXH
 */
@Configuration
public class AiCodeGenServiceFactory {

    // 阻塞调用对象，阻塞调用大模型，直至回复结果生成结束
    private final ChatModel chatModel;
    // 流式调用对象，异步调用大模型，直接返回响应式对象，使用其他线程完成 ai 回复内容的接收
    private final StreamingChatModel streamingChatModel;

    public AiCodeGenServiceFactory(ChatModel chatModel,
                                   StreamingChatModel streamingChatModel) {
        this.chatModel = chatModel;
        this.streamingChatModel = streamingChatModel;
    }

    /**
     * 创建 AI 代码生成器服务
     *
     * @return AI 服务实体
     */
    public IAiCodeGenService createAiCodeGenService(Class<IAiCodeGenService> clazz) {
        return AiServices.builder(clazz)
                .chatModel(chatModel)
                .streamingChatModel(streamingChatModel)
                .build();
    }
}
