package com.zdan.paimengaicodemother.ai.codegen.route;

import cn.hutool.core.bean.BeanUtil;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import dev.langchain4j.service.AiServices;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 代码生成类型智能路由服务工厂
 *
 * @author LXH
 */
@Slf4j
@Configuration
public class AiCodeGenTypeRoutingServiceFactory {

    private final ChatModel chatModel;

    public AiCodeGenTypeRoutingServiceFactory(ChatModel chatModel) {
        this.chatModel = chatModel;
    }

    @Bean
    public AiCodeGenTypeRoutingService aiCodeGenTypeRoutingService() {
        return AiServices.builder(AiCodeGenTypeRoutingService.class)
                .chatModel(chatModel)
                .build();
    }
}
