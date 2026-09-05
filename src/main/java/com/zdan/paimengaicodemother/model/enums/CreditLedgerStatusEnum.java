package com.zdan.paimengaicodemother.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;

/**
 * 积分台账状态枚举（Issue #10，docs/ts_agent/architecture.md §7 扣费协议）
 * 每个 run 一条台账：冻结 → 结算 / 部分退款 / 全额退款；状态迁移由 CreditService 单点驱动，
 * 与 generation_run 终态（done/failed/aborted）一一对应，保证「run 终态与台账状态一致」验收。
 *
 * @author LXH
 */
@Getter
public enum CreditLedgerStatusEnum {

    /**
     * 冻结：确认线框进入 codegen 时刻预扣积分（余额扣减）
     */
    FROZEN("冻结", "FROZEN"),

    /**
     * 结算：生成成功，全额扣费（不再退款）
     */
    SETTLED("结算", "SETTLED"),

    /**
     * 部分退款：中断但已落盘文件，按已完成里程碑折算退款
     */
    PARTIAL_REFUNDED("部分退款", "PARTIAL_REFUNDED"),

    /**
     * 全额退款：失败 / 中断于首个文件落盘前，冻结额全部退回
     */
    REFUNDED("全额退款", "REFUNDED");

    private final String text;
    private final String value;

    CreditLedgerStatusEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }

    /**
     * 根据 value 获取枚举
     *
     * @param value 状态值
     * @return 枚举值，未匹配返回 null
     */
    public static CreditLedgerStatusEnum getEnumByValue(String value) {
        if (ObjUtil.isEmpty(value)) {
            return null;
        }
        for (CreditLedgerStatusEnum anEnum : CreditLedgerStatusEnum.values()) {
            if (anEnum.value.equals(value)) {
                return anEnum;
            }
        }
        return null;
    }
}
