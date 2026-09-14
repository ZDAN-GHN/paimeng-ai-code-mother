package com.zdan.paimengaicodebackend.ai.codegen.route;

import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import dev.langchain4j.service.SystemMessage;

public interface AiCodeGenTypeRoutingService {
    @SystemMessage(fromResource = "prompt/codegen-routing-system-prompt.txt")
    CodeGenTypeEnum routeCodeGenType(String userPrompt);
}
