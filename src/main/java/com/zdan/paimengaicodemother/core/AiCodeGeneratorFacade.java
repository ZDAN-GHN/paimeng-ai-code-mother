package com.zdan.paimengaicodemother.core;

import com.zdan.paimengaicodemother.ai.codegen.AiCodeGenServiceExecutor;
import com.zdan.paimengaicodemother.core.parser.CodeParserExecutor;
import com.zdan.paimengaicodemother.core.saver.CodeFileSaverExecutor;
import com.zdan.paimengaicodemother.exception.BusinessException;
import com.zdan.paimengaicodemother.exception.ErrorCode;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
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
        Flux<String> codeStream = aiCodeGenServiceExecutor.executeCodeGenStream(userMessage, codeGenTypeEnum, appId);
        return processCodeStream(codeStream, codeGenTypeEnum, appId);
    }

    /**
     * 通用流式代码处理方法
     *
     * @param codeStream      代码流
     * @param codeGenTypeEnum 代码生成类型
     * @param appId           应用 id
     * @return 流式响应
     */
    private Flux<String> processCodeStream(Flux<String> codeStream, CodeGenTypeEnum codeGenTypeEnum, Long appId) {
        // 字符串拼接器，用于当流式返回所有的代码之后，再保存代码
        StringBuilder codeBuilder = new StringBuilder();
        return codeStream
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
