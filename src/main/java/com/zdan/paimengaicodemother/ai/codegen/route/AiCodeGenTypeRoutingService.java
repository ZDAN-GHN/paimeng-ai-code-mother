package com.zdan.paimengaicodemother.ai.codegen.route;

import com.zdan.paimengaicodemother.model.enums.CodeGenTypeEnum;
import dev.langchain4j.service.SystemMessage;

/**
 * 代码生成类型智能路由服务
 *
 * @author LXH
 */
public interface AiCodeGenTypeRoutingService {

    /**
     * 根据用户需求智能选择代码生成类型
     *
     * @param userPrompt 用户提示词
     * @return 代码生成类型枚举
     */
    @SystemMessage(fromResource = "prompt/codegen-routing-system-prompt.txt")
    CodeGenTypeEnum routeCodeGenType(String userPrompt);
}
