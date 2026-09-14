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


@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table("generation_run")
public class GenerationRun implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;


    @Id(keyType = KeyType.None)
    private String runId;


    @Column("appId")
    private Long appId;


    @Column("userId")
    private Long userId;


    @Column("phase")
    private String phase;


    @Column("context")
    private String context;


    @Column("milestones")
    private String milestones;


    @Column("tokenUsage")
    private String tokenUsage;


    @Column("creditLedgerRef")
    private String creditLedgerRef;


    @Column("startedTime")
    private LocalDateTime startedTime;


    @Column("finishedTime")
    private LocalDateTime finishedTime;


    @Column("createTime")
    private LocalDateTime createTime;


    @Column("updateTime")
    private LocalDateTime updateTime;


    @Column(value = "isDelete", isLogicDelete = true)
    private Integer isDelete;

}
