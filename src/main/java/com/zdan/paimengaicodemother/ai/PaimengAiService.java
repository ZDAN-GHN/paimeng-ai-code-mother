package com.zdan.paimengaicodemother.ai;

import com.zdan.paimengaicodemother.ai.enums.AiGenerateModeEnum;

/**
 * Paiemng 项目的通用 AI 服务接口，所有的 AI 服务接口都必须继承它
 *
 * @author LXH
 */
public interface PaimengAiService {

    /**
     * 获取工具列表 （默认没有）
     */
    default Object[] getTools() {
        return new Object[0];
    }

    /**
     * AI 工作模式
     */
    default AiGenerateModeEnum getAiGenerateMode() {
        return AiGenerateModeEnum.CHAT;
    }
}
