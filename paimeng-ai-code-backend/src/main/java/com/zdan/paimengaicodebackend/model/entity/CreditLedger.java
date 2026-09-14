package com.zdan.paimengaicodebackend.model.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.io.Serial;
import java.io.Serializable;
import java.time.LocalDateTime;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table("credit_ledger")
public class CreditLedger implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    @Id(keyType = KeyType.Auto)
    private Long id;

    @Column("runId")
    private String runId;

    @Column("userId")
    private Long userId;

    @Column("appId")
    private Long appId;

    @Column("status")
    private String status;

    @Column("frozenAmount")
    private Integer frozenAmount;

    @Column("settleAmount")
    private Integer settleAmount;

    @Column("refundAmount")
    private Integer refundAmount;

    @Column("reason")
    private String reason;

    @Column("milestoneCount")
    private Integer milestoneCount;

    @Column("createTime")
    private LocalDateTime createTime;

    @Column("updateTime")
    private LocalDateTime updateTime;

    @Column(value = "isDelete", isLogicDelete = true)
    private Integer isDelete;
}
