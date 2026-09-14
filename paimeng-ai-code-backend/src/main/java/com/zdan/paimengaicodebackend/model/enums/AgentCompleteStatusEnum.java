package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;


@Getter
public enum AgentCompleteStatusEnum {


    SUCCESS("成功", "success", "complete"),


    FAILED("失败", "failed", "failed"),


    ABORTED("用户中断", "aborted", "interrupted");

    private final String text;
    private final String value;


    private final String reason;

    AgentCompleteStatusEnum(String text, String value, String reason) {
        this.text = text;
        this.value = value;
        this.reason = reason;
    }


    public static AgentCompleteStatusEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (AgentCompleteStatusEnum anEnum : AgentCompleteStatusEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }
}
