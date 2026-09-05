package com.zdan.paimengaicodemother.model.vo;

import lombok.Data;

import java.io.Serial;
import java.io.Serializable;

/**
 * 冻结积分视图（Issue #10）：返回台账关联与冻结结果，供 TS Agent 确认进入 codegen 前置条件
 *
 * @author LXH
 */
@Data
public class CreditFreezeVO implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 台账 id（写回 generation_run.creditLedgerRef 的关联键）
     */
    private Long ledgerId;

    /**
     * 冻结积分数（正数，已从用户余额扣减）
     */
    private Integer frozenAmount;

    /**
     * 冻结后用户积分余额
     */
    private Integer balance;
}
