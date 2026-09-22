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

    @Column("application_id")
    private Long applicationId;

    @Column("event_type")
    private String eventType;

    @Column("actor_type")
    private String actorType;

    @Column("actor_id")
    private Long actorId;

    @Column("reason_code")
    private String reasonCode;

    @Column("request_id")
    private String requestId;

    @Column("occurred_at")
    private LocalDateTime occurredAt;
}
