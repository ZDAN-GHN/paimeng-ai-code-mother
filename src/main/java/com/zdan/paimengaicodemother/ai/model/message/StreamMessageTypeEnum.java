package com.zdan.paimengaicodemother.ai.model.message;

import lombok.Getter;

/**
 * 流式消息类型枚举
 *
 * @author LXH
 */
@Getter
public enum StreamMessageTypeEnum {

    AI_RESPONSE("AI响应", "ai_response"),
    AI_THINkING("AI思考", "ai_thinking"),
    TOOL_REQUEST("工具请求", "tool_request"),
    TOOL_EXECUTED("工具执行结果", "tool_executed")
    ;

    private final String text;
    private final String value;

    StreamMessageTypeEnum(String text, String value) {
        this.value = value;
        this.text = text;
    }

    /**
     * 根据值获取枚举
     */
    public static StreamMessageTypeEnum getEnumByValue(String value) {
        for (StreamMessageTypeEnum typeEnum : values()) {
            if (typeEnum.getValue().equals(value)) {
                return typeEnum;
            }
        }
        return null;
    }
}