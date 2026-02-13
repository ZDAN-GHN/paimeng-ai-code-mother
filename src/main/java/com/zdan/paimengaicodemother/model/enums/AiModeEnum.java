package com.zdan.paimengaicodemother.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * AI 模式枚举
 * @author LXH
 */
@Getter
public enum AiModeEnum {


    CHAT("对话模式", "chat"),
    REASONING("推理模式", "reasoning");

    private final String text;
    private final String value;

    AiModeEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 枚举值的value
     * @return 枚举值
     */
    public static AiModeEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (AiModeEnum anEnum : AiModeEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }
}
