package com.zdan.paimengaicodemother.ai.codegen;

import cn.hutool.aop.ProxyUtil;
import cn.hutool.core.convert.Convert;
import cn.hutool.core.util.ReflectUtil;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.enums.AiModeEnum;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import dev.langchain4j.community.store.memory.chat.redis.RedisChatMemoryStore;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.service.AiServices;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Configuration;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;

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
    private final Cache<String, IAiCodeGenService> aiCodeGenServiceProxyCache;

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
        aiCodeGenServiceProxyCache = Caffeine.newBuilder()
                .maximumSize(1000)
                // 写入 30 分钟后过期
                .expireAfterWrite(Duration.ofMinutes(30))
                // 访问 10 分钟后过期
                .expireAfterAccess(Duration.ofMinutes(10))
                .removalListener(
                        (key, value, cause) ->
                                log.debug("Removed AI CodeGenService Proxy from cache: interfaceName {}, cause: {}", key, cause)
                )
                .build();
    }

    // 阻塞调用对象，阻塞调用大模型，直至回复结果生成结束
    private final ChatModel chatModel;
    // 流式调用对象，异步调用大模型，直接返回响应式对象，使用其他线程完成 ai 回复内容的接收
    private final StreamingChatModel openAiStreamingChatModel;
    private final StreamingChatModel reasoningStreamingChatModel;
    // redis 会话记忆存储
    private final RedisChatMemoryStore redisChatMemoryStoreForCodeGen;
    // 会话历史记录服务
    private final ChatHistoryService chatHistoryService;

    public AiCodeGenServiceFactory(ChatModel chatModel,
                                   StreamingChatModel openAiStreamingChatModel,
                                   StreamingChatModel reasoningStreamingChatModel,
                                   RedisChatMemoryStore redisChatMemoryStoreForCodeGen,
                                   ChatHistoryService chatHistoryService) {
        this.chatModel = chatModel;
        this.openAiStreamingChatModel = openAiStreamingChatModel;
        this.reasoningStreamingChatModel = reasoningStreamingChatModel;
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
        // 根据指定的 ai 模式选择 streamingChatModel
        AiCodeGenService annotation = clazz.getAnnotation(AiCodeGenService.class);
        if (annotation == null) {
            log.info("@AiCodeGenService annotations are missing, check class {}", clazz);
        }
        AiModeEnum aiModeEnum = Objects.requireNonNull(annotation).aiMode();
        StreamingChatModel streamingChatModel = switch (aiModeEnum) {
            case CHAT -> openAiStreamingChatModel;
            case REASONING -> reasoningStreamingChatModel;
            default -> {
                log.error("user tried to select unsupported ai mode: {}", aiModeEnum);
                throw new BusinessException(ErrorCode.OPERATION_ERROR);
            }
        };
        // 从数据库获取数据并加载到会话记忆中
        chatHistoryService.loadChatHistoryToMemory(appId, chatMemory, maxMessages);
        // 从接口的 default 方法中获取工具列表（通过动态代理）
        Object[] tools = getTools(clazz);
        return AiServices.builder(clazz)
                .chatModel(chatModel)
                .streamingChatModel(streamingChatModel)
                // 由于 Langchain4j 规定了如果要使用 @MemoryId 就必须要使用 chatMemoryProvider 来提供会话记忆，这里统一直接使用 chatMemoryProvider 以兼容需要使用上下文的服务
                .chatMemoryProvider(memoryId -> chatMemory)
                // 提供工具（没有就给空数组）
                .tools(tools)
                // 处理工具调用幻觉问题
                .hallucinatedToolNameStrategy(
                        toolExecutionRequest ->
                                ToolExecutionResultMessage.from(
                                        toolExecutionRequest,
                                        "Error: there is no tool called" + toolExecutionRequest.name()
                                )
                )
                .build();
    }

    /**
     * 利用反射，从代码生成服务接口的 class 对象中获取工具集合
     *
     * @param clazz 代码生成服务接口的 class 对象
     * @return 工具集合
     */
    private Object[] getTools(Class<? extends IAiCodeGenService> clazz) {
        Object[] tools;
        IAiCodeGenService tempService = aiCodeGenServiceProxyCache.get(clazz.getName(), key -> {
            try {
                // 通过动态代理创建接口的临时实例，用于执行方法的默认实现
                return ProxyUtil.newProxyInstance((proxy, method, args) -> {
                    // 方法默认有默认实现直接调用
                    if (method.isDefault()) {
                        return InvocationHandler.invokeDefault(proxy, method, args);
                    }
                    // 接口的其他方法都返回 null
                    return null;
                }, clazz);
            } catch (Exception e) {
                log.warn("failed to create proxy for class: {}, failed to invoke getTools()", clazz.getName(), e);
            }
            return null;
        });
        if (tempService != null) {
            tools = tempService.getTools();
        } else {
            // 保证返回非 null 对象
            tools = new Object[]{};
        }
        return tools;
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
                .streamingChatModel(openAiStreamingChatModel)
                .build();
    }
}
