package com.zdan.paimengaicodemother.core;

import cn.hutool.json.JSONUtil;
import com.zdan.paimengaicodemother.ai.codegen.AiCodeGenServiceExecutor;
import com.zdan.paimengaicodemother.ai.model.message.AiResponseMessage;
import com.zdan.paimengaicodemother.ai.model.message.ToolExecutedMessage;
import com.zdan.paimengaicodemother.ai.model.message.ToolRequestMessage;
import com.zdan.paimengaicodemother.core.parser.CodeParserExecutor;
import com.zdan.paimengaicodemother.core.saver.CodeFileSaverExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.exception.ThrowUtils;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.service.TokenStream;
import dev.langchain4j.service.tool.ToolExecution;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Flux;

import java.io.File;

/**
 * AI 代码生成门面类，组合 代码生成 和 代码保存
 *
 * @author LXH
 */
@Service
@Slf4j
public class AiCodeGeneratorFacade {

    private final AiCodeGenServiceExecutor aiCodeGenServiceExecutor;
    private final CodeParserExecutor codeParserExecutor;
    private final CodeFileSaverExecutor codeFileSaverExecutor;

    public AiCodeGeneratorFacade(AiCodeGenServiceExecutor aiCodeGenServiceExecutor,
                                 CodeParserExecutor codeParserExecutor,
                                 CodeFileSaverExecutor codeFileSaverExecutor) {
        this.aiCodeGenServiceExecutor = aiCodeGenServiceExecutor;
        this.codeParserExecutor = codeParserExecutor;
        this.codeFileSaverExecutor = codeFileSaverExecutor;
    }

    /**
     * 统一入口：根据类型生成并保存代码
     *
     * @param userMessage     用户提示词
     * @param codeGenTypeEnum 生成类型
     * @param appId           应用 id
     * @return 保存的目录
     */
    public File generateAndSaveCode(String userMessage, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        validateCodeGenType(codeGenTypeEnum);
        Object result = aiCodeGenServiceExecutor.executeCodeGen(userMessage, codeGenTypeEnum, appId);
        File file = codeFileSaverExecutor.executeSaver(result, CodeGenTypeEnum.HTML, appId);
        return file;
    }

    /**
     * 统一入口：根据类型生成并保存代码（流式）
     *
     * @param userMessage     用户提示词
     * @param codeGenTypeEnum 生成类型
     * @return 保存的目录
     */
    public Flux<String> generateAndSaveCodeStream(String userMessage, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        validateCodeGenType(codeGenTypeEnum);
        Object abstractStream = aiCodeGenServiceExecutor.executeCodeGenStream(userMessage, codeGenTypeEnum, appId);
        return processStream(abstractStream, codeGenTypeEnum, appId);
    }

    /**
     * 流处理统一入口
     *
     * @param stream          代码流
     * @param codeGenTypeEnum 代码生成类型
     * @param appId           应用 id
     * @return 统一返回 Flux 流
     */
    private Flux<String> processStream(Object stream, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        if (stream instanceof Flux<?>) {
            return processFluxStream((Flux<String>) stream, codeGenTypeEnum, appId);
        } else if (stream instanceof TokenStream) {
            return processTokenStream((TokenStream) stream, codeGenTypeEnum, appId);
        }
        log.error("the given stream is not supported: stream: {}, class: {}", stream, stream.getClass().getName());
        ThrowUtils.throwForOperation("系统异常");
        return null;
    }

    /**
     * 处理 langchain4j 提供的 TokenStream
     */
    private Flux<String> processTokenStream(TokenStream tokenStream, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        return Flux.create(
                sink -> {
                    // 监听 tokenStream，对响应碎片做转换，并将转换结果传递给下游 Flux 对象
                    tokenStream.onPartialResponse((String partialResponse) -> {
                                AiResponseMessage aiResponseMessage = new AiResponseMessage(partialResponse);
                                sink.next(JSONUtil.toJsonStr(aiResponseMessage));
                            })
                            .onPartialToolExecutionRequest((index, toolExecutionRequest) -> {
                                ToolRequestMessage toolRequestMessage = new ToolRequestMessage(toolExecutionRequest);
                                sink.next(JSONUtil.toJsonStr(toolRequestMessage));
                            })
                            .onToolExecuted((ToolExecution toolExecution) -> {
                                ToolExecutedMessage toolExecutedMessage = new ToolExecutedMessage(toolExecution);
                                sink.next(JSONUtil.toJsonStr(toolExecutedMessage));
                            })
                            .onCompleteResponse((ChatResponse response) -> {
                                sink.complete();
                            })
                            .onError((Throwable error) -> {
                                log.error("failed to process tokenStream, cause by ", error);
                                ThrowUtils.throwForOperation("响应流处理异常");
                            })
                            .start();
                }
        );
    }

    /**
     * 处理 Flux 流
     */
    private Flux<String> processFluxStream(Flux<String> stringFlux, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        // 字符串拼接器，用于当流式返回所有的代码之后，再保存代码
        StringBuilder codeBuilder = new StringBuilder();
        return stringFlux
                // 实时收集代码片段
                .doOnNext(codeBuilder::append)
                // 回复结束后解析代码
                .doOnComplete(() -> {
                    try {
                        String completeCode = codeBuilder.toString();
                        // 使用执行器解析代码
                        Object parsedResult = codeParserExecutor.executeParser(completeCode, codeGenTypeEnum);
                        // 使用执行器保存代码
                        File saveDir = codeFileSaverExecutor.executeSaver(parsedResult, codeGenTypeEnum, appId);
                        log.info("saving code file completed, savePath: {}, saveDir: {} ", saveDir.getAbsolutePath(), saveDir);
                    } catch (Exception e) {
                        log.error("failed to save code file with exception: {} ", e.getMessage());
                    }
                });
    }

    /**
     * 校验生成类型
     *
     * @param codeGenTypeEnum 生成类型
     */
    private static void validateCodeGenType(CodeGenTypeEnum codeGenTypeEnum) {
        if (codeGenTypeEnum == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "生成类型为空");
        } else if (CodeGenTypeEnum.getEnumByValue(codeGenTypeEnum.getValue()) == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "生成类型不支持");
        }
    }
}
