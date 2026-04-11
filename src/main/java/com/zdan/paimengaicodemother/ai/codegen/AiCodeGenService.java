package com.zdan.paimengaicodemother.ai.codegen;

import com.zdan.paimengaicodemother.ai.PaimengAiService;

/**
 * ai 代码生成服务
 *
 * @author LXH
 */
public interface AiCodeGenService extends PaimengAiService {

    /**
     * 生成代码
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果（非流对象）
     */
    <T> T generateCode(String userMessage);

    /**
     * 生成代码（流式）
     *
     * @param appId       应用 id
     * @param userMessage 用户提示词
     * @return AI 输出结果（流式对象）
     */
    <S> S generateCodeStream(Long appId, String userMessage);
}
