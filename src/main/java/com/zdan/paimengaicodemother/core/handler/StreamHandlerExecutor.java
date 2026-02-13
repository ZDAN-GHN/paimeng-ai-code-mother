package com.zdan.paimengaicodemother.core.handler;

import cn.hutool.core.util.StrUtil;
import com.zdan.paimengaicodemother.constant.AppConstant;
import com.zdan.paimengaicodemother.core.builder.BuilderExecutor;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.entity.User;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.service.ChatHistoryService;
import jakarta.annotation.Resource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Flux;

import java.util.Objects;

/**
 * 流处理器执行器
 * 根据代码生成类型创建合适的流处理器：
 * 1. 传统的 Flux<String> 流（HTML、MULTI_FILE） -> SimpleTextStreamHandler
 * 2. TokenStream 格式的复杂流（VUE_PROJECT） -> JsonMessageStreamHandler
 *
 * @author LXH
 */
@Slf4j
@Component
public class StreamHandlerExecutor {
    @Resource
    private final JsonMessageStreamHandler jsonMessageStreamHandler;
    private final SimpleTextStreamHandler simpleTextStreamHandler;

    public StreamHandlerExecutor(JsonMessageStreamHandler jsonMessageStreamHandler,
                                 SimpleTextStreamHandler simpleTextStreamHandler) {
        this.jsonMessageStreamHandler = jsonMessageStreamHandler;
        this.simpleTextStreamHandler = simpleTextStreamHandler;
    }

    /**
     * 创建流处理器并处理聊天历史记录
     *
     * @param originFlux         原始流
     * @param chatHistoryService 聊天历史服务
     * @param appId              应用ID
     * @param loginUser          登录用户
     * @param codeGenType        代码生成类型
     * @return 处理后的流
     */
    public Flux<String> doHandle(Flux<String> originFlux,
                                 ChatHistoryService chatHistoryService,
                                 long appId, User loginUser, CodeGenTypeEnum codeGenType) {
        Flux<String> afterParse = parseStringFlux(originFlux, chatHistoryService, appId, loginUser, codeGenType);
        return Objects.requireNonNull(afterParse).doOnComplete(
                () -> BuilderExecutor.doBuildAsync(
                        codeGenType,
                        StrUtil.format("{}/{}_project_{}", AppConstant.CODE_OUTPUT_ROOT_DIR, codeGenType.getValue(), appId)
                )
        );
    }

    private Flux<String> parseStringFlux(Flux<String> originFlux, ChatHistoryService chatHistoryService, long appId,
                                         User loginUser,
                                         CodeGenTypeEnum codeGenType) {
        return switch (codeGenType.getBuildType()) {
            // 使用注入的组件实例
            case NPM -> jsonMessageStreamHandler.handle(originFlux, chatHistoryService, appId, loginUser);
            case NONE -> simpleTextStreamHandler.handle(originFlux, chatHistoryService, appId, loginUser);
            default -> {
                log.error("failed to handle originFlux, cause by unsupported codeGenType: {}", codeGenType);
                ThrowUtils.throwForParam("生成失败，无法构建指定类型的项目");
                yield null;
            }
        };
    }
}
