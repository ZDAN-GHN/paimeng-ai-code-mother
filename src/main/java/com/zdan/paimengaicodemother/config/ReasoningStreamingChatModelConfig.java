package com.zdan.paimengaicodemother.config;

import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.model.openai.OpenAiStreamingChatModel;
import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Scope;

/**
 * 流式返回推理模型
 *
 * @author LXH
 */
@Configuration
@ConfigurationProperties(prefix = "langchain4j.open-ai.reasoning-streaming-chat-model")
@Data
public class ReasoningStreamingChatModelConfig {

    private String baseUrl;

    private String apiKey;

    private String modelName;

    private Integer maxTokens;

    private Double temperature;

    private Boolean logRequests = false;

    private Boolean logResponses = false;

    private Boolean accumulateToolCallId = true;

    private Boolean sendThinking = false;

    private Boolean returnThinking = false;

    private String thinkingField = "reasoning_content";

    private Double presencePenalty;

    private Double frequencyPenalty;

    @Bean
    @Scope("prototype")
    public StreamingChatModel reasoningStreamingChatModelPrototype() {
        return OpenAiStreamingChatModel.builder()
                .apiKey(apiKey)
                .baseUrl(baseUrl)
                .modelName(modelName)
                .maxTokens(maxTokens)
                .temperature(temperature)
                .logRequests(logRequests)
                .logResponses(logResponses)
                // 工具调用 id 是否增量构造，deepseek 即便在流式调用中，也是完整返回工具调用 id，所以为 false
                .accumulateToolCallId(accumulateToolCallId)
                /*  下面两项需要同时开启（因为回传就必须要接收到思考内容才能回传） */
                // 将接收到的思考文本回传给 ai，字段名设置为 deepseek 的规定的名称（虽然默认就是这个字段）
                .sendThinking(sendThinking, thinkingField)
                // 解析并接收 ai 回复的思考文本（如果有的话）
                .returnThinking(returnThinking)
                // 并行工具调用
                .parallelToolCalls(true)
                // 以下两个配置均为减少生成重复配置
                // 存在惩罚：控制 token “是否出现过”，施加固定惩罚，与出现次数无关
                .presencePenalty(presencePenalty)
                // 频率惩罚：控制 token “出现多少次”，惩罚随次数线性累积
                .frequencyPenalty(frequencyPenalty)
                // 开启工具调用参数严格 json 格式，减少自动化过程工具调用错误传参，保证自动化的可靠性
                .strictTools(true)
                .build();
    }
}
