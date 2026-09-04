package com.zdan.paimengaicodemother.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * Agent 完成回调状态枚举（Issue #6）
 * 与 Agent 完成回调契约的 status 取值（success/failed）一一对应；
 * 在 Java 侧收敛为类型安全的单点判断，避免散落的字符串字面量比较。
 *
 * @author LXH
 */
@Getter
public enum AgentCompleteStatusEnum {

    /**
     * 成功：写对话历史 + 触发构建
     */
    SUCCESS("成功", "success"),

    /**
     * 失败：写错误历史，不触发构建
     */
    FAILED("失败", "failed");

    private final String text;
    private final String value;

    AgentCompleteStatusEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 状态值
     * @return 枚举值，未匹配返回 null
     */
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
