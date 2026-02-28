package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.model.MultiFileCodeResult;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.UserMessage;
import reactor.core.publisher.Flux;

/**
 * ai 代码生成服务（HTML）
 *
 * @author LXH
 */
@AiCodeGenService(codeGenTypeEnum = CodeGenTypeEnum.MULTI_FILE)
public interface MultiFileCodeGenService extends IAiCodeGenService {

    /**
     * 生成多文件代码
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-multi-file-system-prompt.txt")
    MultiFileCodeResult generateCode(String userMessage);

    /**
     * 生成多文件代码（流式）
     *
     * @param appId 应用 id
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-multi-file-system-prompt.txt")
    Flux<String> generateCodeStream(@MemoryId Long appId, @UserMessage String userMessage);
}
