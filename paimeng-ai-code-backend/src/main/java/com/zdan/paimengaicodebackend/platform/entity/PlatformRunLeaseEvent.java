package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * Append-only Lease 审计事件。活跃 Lease 行被删除后，证据仍保留在此表。
 * fenceToken 的单调性由本表历史最大值推导，不依赖额外计数器。
 */
@Data
@Table("platform_run_lease_event")
public class PlatformRunLeaseEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("appId")
    private Long applicationId;

    @Column("runId")
    private String runId;

    @Column("taskId")
    private Long taskId;

    @Column("eventType")
    private String eventType;

    @Column("fenceToken")
    private Long fenceToken;

    @Column("actorType")
    private String actorType;

    @Column("reasonCode")
    private String reasonCode;

    @Column("requestId")
    private String requestId;

    @Column("occurredTime")
    private LocalDateTime occurredAt;
}
