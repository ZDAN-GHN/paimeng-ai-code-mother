package com.zdan.paimengaicodemother.ai.codegen;

import reactor.core.publisher.Flux;

/**
 * ai 代码生成服务
 *
 * @author LXH
 */
public interface IAiCodeGenService {

    /**
     * 生成代码
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    <T> T generateCode(String userMessage);

    /**
     * 生成代码（流式）
     *
     * @param userMessage 用户提示词
     * @return AI 输出结果
     */
    Flux<String> generateCodeStream(String userMessage);
}
