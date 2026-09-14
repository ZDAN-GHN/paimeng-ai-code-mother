package com.zdan.paimengaicodebackend.model.enums;

import cn.hutool.core.util.ObjUtil;
import lombok.Getter;


@Getter
public enum CreditLedgerStatusEnum {


    FROZEN("冻结", "FROZEN"),


    SETTLED("结算", "SETTLED"),


    PARTIAL_REFUNDED("部分退款", "PARTIAL_REFUNDED"),


    REFUNDED("全额退款", "REFUNDED");

    private final String text;
    private final String value;

    CreditLedgerStatusEnum(String text, String value) {
        this.text = text;
        this.value = value;
    }


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
