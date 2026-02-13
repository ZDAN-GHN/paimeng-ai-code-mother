package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.tools.FileWriteTool;
import com.zdan.paimengaicodemother.model.enums.AiModeEnum;
import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.TokenStream;
import dev.langchain4j.service.UserMessage;
import reactor.core.publisher.Flux;

import java.util.ArrayList;

/**
 * ai 代码生成服务（vue）
 *
 * @author LXH
 */
@AiCodeGenService(
        codeGenTypeEnum = CodeGenTypeEnum.VUE_PROJECT,
        aiMode = AiModeEnum.REASONING
)
public interface VueCodeGenService extends IAiCodeGenService {

    @Override
    default Object[] getTools() {
        ArrayList<Object> tools = new ArrayList<>();
        tools.add(new FileWriteTool());
        return tools.toArray();
    }

    /**
     * 生成 Vue 项目代码（流式）
     *
     * @param appId       应用 id
     * @param userMessage 用户消息
     * @return 生成过程的流式响应
     */
    @Override
    @SystemMessage(fromResource = "prompt/codegen-vue-project-system-prompt.txt")
    TokenStream generateCodeStream(@MemoryId Long appId, @UserMessage String userMessage);
}
