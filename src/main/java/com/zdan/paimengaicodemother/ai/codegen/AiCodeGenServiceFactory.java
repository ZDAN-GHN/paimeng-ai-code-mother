package com.zdan.paimengaicodemother.ai.codegen;

import cn.hutool.aop.ProxyUtil;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.zdan.paimengaicodemother.ai.enums.AiGenerateModeEnum;
import com.zdan.paimengaicodemother.ai.guardrail.PromptSafetyInputGuardrail;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import com.zdan.paimengaicodemother.utils.SpringContextUtil;
import dev.langchain4j.community.store.memory.chat.redis.RedisChatMemoryStore;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.memory.chat.MessageWindowChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.service.AiServices;
import lombok.extern.slf4j.Slf4j;
import org.jetbrains.annotations.Nullable;
import org.springframework.context.annotation.Configuration;

import java.lang.reflect.InvocationHandler;
import java.time.Duration;

/**
 * ai 代码生成服务创建工厂
 *
 * @author LXH
 */
@Configuration
@Slf4j
public class AiCodeGenServiceFactory {


    // caffeine 缓存，缓存 LangCain4j 生成的 ai 服务代理对象
    private final Cache<Long, AiCodeGenService> aiCodeGenServiceCache;
    // caffeine 缓存，缓存 ai 服务的假实现
    private final Cache<String, AiCodeGenService> aiCodeGenServiceFakeInstanceCache;

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
        aiCodeGenServiceFakeInstanceCache = Caffeine.newBuilder()
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
    private final ChatModel openAiChatModel;
    // 流式调用对象，异步调用大模型，直接返回响应式对象，使用其他线程完成 ai 回复内容的接收
    private final StreamingChatModel openAiStreamingChatModel; // 该对象已弃用，后续代码不会使用到此对象（单例无法实现并发执行 ai 对话）
    // redis 会话记忆存储
    private final RedisChatMemoryStore redisChatMemoryStoreForCodeGen;
    // 会话历史记录服务
    private final ChatHistoryService chatHistoryService;

    public AiCodeGenServiceFactory(ChatModel openAiChatModel,
                                   StreamingChatModel openAiStreamingChatModel,
                                   RedisChatMemoryStore redisChatMemoryStoreForCodeGen,
                                   ChatHistoryService chatHistoryService) {
        this.openAiChatModel = openAiChatModel;
        this.openAiStreamingChatModel = openAiStreamingChatModel;
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
    public AiCodeGenService getAiCodeGenService(Class<? extends AiCodeGenService> clazz, Long appId) {
        // 从内存中获取服务实例，如果没有则调用 lambda 创建 键值对（相当于 Map 的 computeIfAbsent）
        return aiCodeGenServiceCache.get(appId,
                // 同一个 key 的 mappingFunction 只会被调用一次，当多个线程同时请求同一个不存在的 key 时，只有一个线程会执行 mappingFunction，其他线程会阻塞等待结果
                key -> {
                    AiCodeGenService aiCodeGenService = createAiCodeGenService(clazz, key);
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
    public AiCodeGenService createAiCodeGenService(Class<? extends AiCodeGenService> clazz, Long appId) {
        final int maxMessages = 20;
        MessageWindowChatMemory chatMemory = MessageWindowChatMemory.builder()
                .id(appId)
                .chatMemoryStore(redisChatMemoryStoreForCodeGen)
                .maxMessages(maxMessages)
                .build();
        // 根据指定的 ai 模式选择 streamingChatModel
        CodeGenType codeGenType = clazz.getAnnotation(CodeGenType.class);
        if (codeGenType == null) {
            log.info("@AiCodeGenService annotations are missing, check class {}", clazz);
        }
        AiGenerateModeEnum aiGenerateModeEnum = getAiWorkMode(clazz);
        // 根据服务指定的模型枚举类型动态选择对应的模型多例对象（每个模型对象都持有一个 SpringRestClient （可理解为只有一个工作线程的 ExecutorService），
        // 底层的 SpringRestClient.execute() 方法内部实际上是同步解析数据流的，导致了串行执行问题，通过多例化 StreamingChatModel 便可以轻松解决这个问题）
        StreamingChatModel streamingChatModel = switch (aiGenerateModeEnum) {
            case CHAT -> // 对话模型（普通模型）
                    SpringContextUtil.getBean("chatStreamingChatModelPrototype", StreamingChatModel.class);
            case REASONING -> // 推理模型
                    SpringContextUtil.getBean("reasoningStreamingChatModelPrototype", StreamingChatModel.class);
            default -> {
                log.error("user tried to select unsupported ai mode: {}", aiGenerateModeEnum);
                throw new BusinessException(ErrorCode.SYSTEM_ERROR);
            }
        };
        // 从数据库获取数据并加载到会话记忆中
        chatHistoryService.loadChatHistoryToMemory(appId, chatMemory, maxMessages);
        // 从接口的 default 方法中获取工具列表（通过动态代理）
        Object[] tools = getTools(clazz);
        return AiServices.builder(clazz)
                .chatModel(openAiChatModel)
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
                // 最大工具调用次数
                .maxSequentialToolsInvocations(50)
                // 输入护轨（对提示词做安全检查）
                .inputGuardrails(new PromptSafetyInputGuardrail())
                .build();
    }

    /**
     * 利用反射，从代码生成服务接口的 class 对象中获取工具集合
     *
     * @param clazz 代码生成服务接口的 class 对象
     * @return AI 工作模式
     */
    private AiGenerateModeEnum getAiWorkMode(Class<? extends AiCodeGenService> clazz) {
        AiGenerateModeEnum aiMode;
        AiCodeGenService fakeService = getAiCodeServiceFakeInstance(clazz);
        if (fakeService != null) {
            aiMode = fakeService.getAiGenerateMode();
        } else {
            // 保证返回非 null 对象
            aiMode = AiGenerateModeEnum.CHAT;
        }
        return aiMode;
    }

    /**
     * 利用反射，从代码生成服务接口的 class 对象中获取工具集合
     *
     * @param clazz 代码生成服务接口的 class 对象
     * @return 工具集合
     */
    private Object[] getTools(Class<? extends AiCodeGenService> clazz) {
        Object[] tools;
        AiCodeGenService fakeService = getAiCodeServiceFakeInstance(clazz);
        if (fakeService != null) {
            tools = fakeService.getTools();
        } else {
            // 保证返回非 null 对象
            tools = new Object[]{};
        }
        return tools;
    }

    /**
     * 获取 AI 代码生成服务的假实现，生成的对象只用于的执行 default 方法
     * @param clazz 代码生成服务接口的 class 对象
     * @return 该 class 的假实体
     */
    private @Nullable AiCodeGenService getAiCodeServiceFakeInstance(Class<? extends AiCodeGenService> clazz) {
        return aiCodeGenServiceFakeInstanceCache.get(clazz.getName(), key -> {
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
    }

    /**
     * 创建 AI 代码生成器服务 - 无会话记忆
     *
     * @param clazz 实例服务的 class 对象
     * @return AI 服务实体
     */
    @Deprecated
    public AiCodeGenService createAiCodeGenService(Class<? extends AiCodeGenService> clazz) {
        return AiServices.builder(clazz)
                .chatModel(openAiChatModel)
                .streamingChatModel(openAiStreamingChatModel)
                .build();
    }
}
