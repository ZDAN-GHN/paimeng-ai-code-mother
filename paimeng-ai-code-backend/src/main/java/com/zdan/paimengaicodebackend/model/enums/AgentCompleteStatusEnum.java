package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * Agent 完成回调状态枚举（Issue #6 + #10）
 * 与 Agent 完成回调契约的 status 取值（success/failed/aborted）一一对应；
 * 在 Java 侧收敛为类型安全的单点判断，避免散落的字符串字面量比较。
 *
 * @author LXH
 */
@Getter
public enum AgentCompleteStatusEnum {

    /**
     * 成功：写对话历史 + 触发构建 + 积分结算（台账 FROZEN → SETTLED）
     */
    SUCCESS("成功", "success", "complete"),

    /**
     * 失败：写错误历史 + 全额退款（台账 FROZEN → REFUNDED）
     */
    FAILED("失败", "failed", "failed"),

    /**
     * 用户中断（Issue #10，架构 §3.5 中止 (a)）：保留已写文件 + 历史带 [用户中断] 标记
     * + 按已完成里程碑折算退款（首个文件落盘前全额退款，台账 → PARTIAL_REFUNDED / REFUNDED）
     */
    ABORTED("用户中断", "aborted", "interrupted");

    private final String text;
    private final String value;

    /**
     * 台账终态 reason（credit_ledger.reason，单一来源：与状态绑定，杜绝散落魔法字符串）
     */
    private final String reason;

    AgentCompleteStatusEnum(String text, String value, String reason) {
        this.text = text;
        this.value = value;
        this.reason = reason;
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
