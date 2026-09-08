package com.zdan.paimengaicodemother.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * 推理强度档位枚举（Issue #10 审查整改：消除 calcFrozenAmount 中 "fast"/"standard"/"deep" 魔法字符串）
 * 与 TS Agent INTENSITY_TIERS 的 key 对齐（fast/standard/deep）；档位系数由 agent.credit.*-multiplier 配置驱动。
 *
 * @author LXH
 */
@Getter
public enum AgentIntensityEnum {

    /**
     * 快速档（系数 0.5，上限随档位收紧）
     */
    FAST("快速", "fast"),

    /**
     * 标准档（缺省档位，系数 1）
     */
    STANDARD("标准", "standard"),

    /**
     * 深度档（系数 2，上限随档位放大）
     */
    DEEP("深度", "deep");

    private final String text;
    private final String value;

    AgentIntensityEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 档位值
     * @return 枚举值，未匹配返回 null
     */
    public static AgentIntensityEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (AgentIntensityEnum anEnum : AgentIntensityEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }
}
