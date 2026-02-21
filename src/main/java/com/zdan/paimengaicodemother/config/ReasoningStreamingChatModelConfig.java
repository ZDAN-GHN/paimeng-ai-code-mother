package com.zdan.paimengaicodemother.config;

import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 流式返回推理模型
 *
 * @author LXH
 */
@Configuration
@ConfigurationProperties(prefix = "langchain4j.open-ai.chat-model")
@Data
public class ReasoningStreamingChatModelConfig {

    private String baseUrl;

    private String apiKey;

    @Bean
    public StreamingChatModel reasoningStreamingChatModel() {
        // 开发环境
        boolean thinking = false;
        final String modelName = "deepseek-chat";
        final int maxTokens = 8192;
        // 生产环境
//        boolean thinking = true;
//        final String modelName = "deepseek-reasoner";
//        final int maxTokens = 32768;
        return OpenAiStreamingChatModel.builder()
                .baseUrl(baseUrl)
                .apiKey(apiKey)
                .modelName(modelName)
                .maxTokens(maxTokens)
                .logRequests(true)
                .logResponses(true)
                // 工具调用 id 是否增量构造，deepseek 即便在流式调用中，也是完整返回工具调用 id，所以为 false
                .accumulateToolCallId(false)
                /*  下面两项需要同时开启（因为回传就必须要接收到思考内容才能回传） */
                // 将接收到的思考文本回传给 ai，字段名设置为 deepseek 的规定的名称（虽然默认就是这个字段）
                .sendThinking(thinking, "reasoning_content")
                // 解析并接收 ai 回复的思考文本（如果有的话）
                .returnThinking(thinking)
                .build();
    }
}
