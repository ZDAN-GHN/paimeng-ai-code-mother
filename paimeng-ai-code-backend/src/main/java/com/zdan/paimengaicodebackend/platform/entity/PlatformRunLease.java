package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 活跃写入 Lease。每个 Application 最多一行，由唯一约束保证。
 * 释放即删除本行，历史证据保留在 {@link PlatformRunLeaseEvent}。
 */
@Data
@Table("platform_run_lease")
public class PlatformRunLease {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("appId")
    private Long applicationId;

    @Column("runId")
    private String runId;

    @Column("taskId")
    private Long taskId;

    @Column("fenceToken")
    private Long fenceToken;

    @Column(value = "grantedTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime grantedAt;

    @Column("expiresTime")
    private LocalDateTime expiresAt;

    @Column("renewCount")
    private Integer renewCount;

    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;

    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
    private LocalDateTime updatedAt;
}
