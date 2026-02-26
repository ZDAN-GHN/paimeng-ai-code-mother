package com.zdan.paimengaicodemother.langgraph4j.ai;

import com.zdan.paimengaicodemother.langgraph4j.tools.ImageSearchTool;
import com.zdan.paimengaicodemother.langgraph4j.tools.LogoGeneratorTool;
import com.zdan.paimengaicodemother.langgraph4j.tools.MermaidDiagramTool;
import com.zdan.paimengaicodemother.langgraph4j.tools.UndrawIllustrationTool;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.service.AiServices;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 图片搜集服务工厂
 *
 * @author LXH
 */
@Slf4j
@Configuration
@AllArgsConstructor
public class ImageCollectionServiceFactory {

    private ChatModel openAiChatModel;
    private ImageSearchTool imageSearchTool;
    private UndrawIllustrationTool undrawIllustrationTool;
    private MermaidDiagramTool mermaidDiagramTool;
    private LogoGeneratorTool logoGeneratorTool;

    /**
     * 创建图片收集 AI 服务
     */
    @Bean
    public ImageCollectionService createImageCollectionService() {
        return AiServices.builder(ImageCollectionService.class)
                .chatModel(openAiChatModel)
                .tools(
                        imageSearchTool,
                        undrawIllustrationTool,
                        mermaidDiagramTool,
                        logoGeneratorTool
                )
                .build();
    }
}