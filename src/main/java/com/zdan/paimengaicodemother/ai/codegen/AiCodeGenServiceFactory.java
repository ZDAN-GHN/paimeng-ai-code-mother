package com.zdan.paimengaicodemother.ai.codegen;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import dev.langchain4j.community.store.memory.chat.redis.RedisChatMemoryStore;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.service.AiServices;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

/**
 * ai 代码生成服务创建工厂
 *
 * @author LXH
 */
@Configuration
@Slf4j
public class AiCodeGenServiceFactory {

    // caffeine 缓存，缓存 ai 服务
    private final Cache<Long, IAiCodeGenService> aiCodeGenServiceCache;

    {
        aiCodeGenServiceCache = Caffeine.newBuilder()
                .maximumSize(1000)
                // 写入 30 分钟后过期
                .expireAfterWrite(Duration.ofMinutes(30))
                // 访问 10 分钟后过期
                .expireAfterAccess(Duration.ofMinutes(10))
                .removalListener(
                        (key, value, cause) ->
                                log.debug("Removed AI CodeGenService from cache, appId: {}, cause: {}", key, cause)
                )
                .build();
    }

    // 阻塞调用对象，阻塞调用大模型，直至回复结果生成结束
    private final ChatModel chatModel;
    // 流式调用对象，异步调用大模型，直接返回响应式对象，使用其他线程完成 ai 回复内容的接收
    private final StreamingChatModel streamingChatModel;
    // redis 会话记忆存储
    private final RedisChatMemoryStore redisChatMemoryStoreForCodeGen;
    // 会话历史记录服务
    private final ChatHistoryService chatHistoryService;

    public AiCodeGenServiceFactory(ChatModel chatModel,
                                   StreamingChatModel streamingChatModel,
                                   RedisChatMemoryStore redisChatMemoryStoreForCodeGen,
                                   ChatHistoryService chatHistoryService) {
        this.chatModel = chatModel;
        this.streamingChatModel = streamingChatModel;
        this.redisChatMemoryStoreForCodeGen = redisChatMemoryStoreForCodeGen;
        this.chatHistoryService = chatHistoryService;
    }

    /**
     * 获取 ai 代码生成服务实例 - 有记忆功能，优先从缓存中取，不存在调用创建
     *
     * @param clazz 实例服务的 class 对象
     * @param appId 应用 id
     * @return AI 服务实体
     */
    public IAiCodeGenService getAiCodeGenService(Class<? extends IAiCodeGenService> clazz, Long appId) {
        // 从内存中获取服务实例，如果没有则调用 lambda 创建 键值对（相当于 Map 的 computeIfAbsent）
        return aiCodeGenServiceCache.get(appId,
                key -> {
                    IAiCodeGenService aiCodeGenService = createAiCodeGenService(clazz, key);
                    log.debug("instanced aiCodeGenService, appId: {}, aiCodeGenService: {}", key, aiCodeGenService);
                    return aiCodeGenService;
                }
        );
    }

    /**
     * 创建 AI 代码生成器服务 - 有会话记忆，根据 appId 创建服务实例以实现记忆隔离（Langchain4j 框架可以实现记忆隔离，但分应用创建服务实例隔离效果比较好，灵活）
     *
     * @param clazz 实例服务的 class 对象
     * @param appId 应用 id
     * @return AI 服务实体
     */
    public IAiCodeGenService createAiCodeGenService(Class<? extends IAiCodeGenService> clazz, Long appId) {
        final int maxMessages = 20;
        MessageWindowChatMemory chatMemory = MessageWindowChatMemory.builder()
                .id(appId)
                .chatMemoryStore(redisChatMemoryStoreForCodeGen)
                .maxMessages(maxMessages)
                .build();
        // 从数据库获取数据并加载到会话记忆中
        chatHistoryService.loadChatHistoryToMemory(appId, chatMemory, maxMessages);
        return AiServices.builder(clazz)
                .chatModel(chatModel)
                .streamingChatModel(streamingChatModel)
                .chatMemory(chatMemory)
                .build();
    }

    /**
     * 创建 AI 代码生成器服务 - 无会话记忆
     *
     * @param clazz 实例服务的 class 对象
     * @return AI 服务实体
     */
    @Deprecated
    public IAiCodeGenService createAiCodeGenService(Class<? extends IAiCodeGenService> clazz) {
        return AiServices.builder(clazz)
                .chatModel(chatModel)
                .streamingChatModel(streamingChatModel)
                .build();
    }
}
