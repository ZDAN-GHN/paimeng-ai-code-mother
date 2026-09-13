package com.zdan.paimengaicodebackend.model.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;

/**
 * 积分台账（credit_ledger）实体类
 * 扣费协议（docs/ts_agent/architecture.md §7）：预冻结 → 完成结算 → 中断/失败退款；
 * 每个 run 一条台账（uk_runId 幂等），与业务表同库同事务保证原子性。
 *
 * @author LXH
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table("credit_ledger")
public class CreditLedger implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 台账 id
     */
    @Id(keyType = KeyType.Auto)
    private Long id;

    /**
     * 运行 id（幂等键，同 run 一条台账）
     */
    @Column("runId")
    private String runId;

    /**
     * 用户 id
     */
    @Column("userId")
    private Long userId;

    /**
     * 应用 id
     */
    @Column("appId")
    private Long appId;

    /**
     * 台账状态（FROZEN/SETTLED/PARTIAL_REFUNDED/REFUNDED，见 CreditLedgerStatusEnum）
     */
    @Column("status")
    private String status;

    /**
     * 冻结积分数（正数，进入 codegen 时预扣）
     */
    @Column("frozenAmount")
    private Integer frozenAmount;

    /**
     * 结算积分数（实际扣费，正数；结算时写入）
     */
    @Column("settleAmount")
    private Integer settleAmount;

    /**
     * 退款积分数（正数；退款时写入）
     */
    @Column("refundAmount")
    private Integer refundAmount;

    /**
     * 终态原因：complete/interrupted/failed
     */
    @Column("reason")
    private String reason;

    /**
     * 中断时已过里程碑数（退款折算锚）
     */
    @Column("milestoneCount")
    private Integer milestoneCount;

    /**
     * 创建时间
     */
    @Column("createTime")
    private LocalDateTime createTime;

    /**
     * 更新时间
     */
    @Column("updateTime")
    private LocalDateTime updateTime;

    /**
     * 是否删除
     */
    @Column(value = "isDelete", isLogicDelete = true)
    private Integer isDelete;

}
