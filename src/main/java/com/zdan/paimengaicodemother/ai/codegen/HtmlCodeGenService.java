package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.model.HtmlCodeResult;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import dev.langchain4j.service.SystemMessage;
import reactor.core.publisher.Flux;

/**
 * ai 代码生成服务（HTML）
 *
 * @author LXH
 */
@AiCodeGenService(codeGenTypeEnum = CodeGenTypeEnum.HTML)
public interface HtmlCodeGenService extends IAiCodeGenService {

    /**
     * 生成 HTML 代码
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-html-system-prompt.txt")
    HtmlCodeResult generateCode(String userMessage);

    /**
     * 生成 HTML 代码（流式）
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-html-system-prompt.txt")
    Flux<String> generateCodeStream(String userMessage);
}
