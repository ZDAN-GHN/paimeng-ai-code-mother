package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.enums.AiGenerateModeEnum;
import com.zdan.paimengaicodemother.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodemother.ai.tools.*;
import dev.langchain4j.service.MemoryId;
import dev.langchain4j.service.SystemMessage;
import dev.langchain4j.service.TokenStream;
import dev.langchain4j.service.UserMessage;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * ai 代码生成服务（vue）
 *
 * @author LXH
 */
@CodeGenType(codeGenTypeEnum = CodeGenTypeEnum.VUE_PROJECT)
public interface VueCodeGenService extends AiCodeGenService {

    @Override
    default AiGenerateModeEnum getAiGenerateMode() {
        return AiGenerateModeEnum.REASONING;
    }

    /**
     * 生成的项目类型
     */
    String PROJECT_TYPE = VueCodeGenService.class.getAnnotation(CodeGenType.class).codeGenTypeEnum().getValue();

    @Override
    default Object[] getTools() {
        List<Object> tools = new ArrayList<>(
                Arrays.asList(
                        new ProjectFileWriteTool(PROJECT_TYPE),
                        new ProjectFileReadTool(PROJECT_TYPE),
                        new ProjectFileModifyTool(PROJECT_TYPE),
                        new ProjectFileDirReadTool(PROJECT_TYPE),
                        new ProjectFileDeleteTool(PROJECT_TYPE),
                        new ExitTool()
                )
        );
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
