package com.zdan.paimengaicodemother.model.entity;

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
 * 生成运行（generation_run）实体类
 * run 状态持久化通道（docs/ts_agent/architecture.md §3.2）：TS Agent 不直连 MySQL，经 Java 内部 API 读写本表。
 *
 * @author LXH
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@Table("generation_run")
public class GenerationRun implements Serializable {

    @Serial
    private static final long serialVersionUID = 1L;

    /**
     * 运行 id（主键，由调用方生成，复用现有 runId 语义：UUID）
     */
    @Id(keyType = KeyType.None)
    private String runId;

    /**
     * 应用 id
     */
    @Column("appId")
    private Long appId;

    /**
     * 创建用户 id
     */
    @Column("userId")
    private Long userId;

    /**
     * 运行阶段（显式枚举，见 GenerationRunPhaseEnum）
     */
    @Column("phase")
    private String phase;

    /**
     * 运行上下文 JSON（访谈结论/已确认线框路径/plan，XState 快照序列化于此）
     */
    @Column("context")
    private String context;

    /**
     * 已过里程碑列表 JSON（退款粒度的锚）
     */
    @Column("milestones")
    private String milestones;

    /**
     * token 计量 JSON（prompt/completion，定价校准与对账）
     */
    @Column("tokenUsage")
    private String tokenUsage;

    /**
     * 积分台账引用（冻结-结算-退款关联，预留）
     */
    @Column("creditLedgerRef")
    private String creditLedgerRef;

    /**
     * 开始时间
     */
    @Column("startedTime")
    private LocalDateTime startedTime;

    /**
     * 结束时间（进入终态的时刻）
     */
    @Column("finishedTime")
    private LocalDateTime finishedTime;

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
