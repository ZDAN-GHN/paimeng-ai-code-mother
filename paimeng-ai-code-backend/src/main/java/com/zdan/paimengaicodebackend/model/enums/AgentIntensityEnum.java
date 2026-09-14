package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;


@Getter
public enum AgentIntensityEnum {


    FAST("快速", "fast"),


    STANDARD("标准", "standard"),


    DEEP("深度", "deep");

    private final String text;
    private final String value;

    AgentIntensityEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }


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
