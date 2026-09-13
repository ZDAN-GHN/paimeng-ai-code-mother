package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.ai.model.HtmlCodeResult;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
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
     * @param appId       应用 id
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-html-system-prompt.txt")
    Flux<String> generateCodeStream(@MemoryId Long appId, @UserMessage String userMessage);
}
