package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_application_lifecycle_event")
public class PlatformApplicationLifecycleEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("appId")
    private Long applicationId;

    @Column("eventType")
    private String eventType;

    @Column("actorType")
    private String actorType;

    @Column("actorId")
    private Long actorId;

    @Column("reasonCode")
    private String reasonCode;

    @Column("requestId")
    private String requestId;

    @Column("occurredTime")
    private LocalDateTime occurredAt;
}
