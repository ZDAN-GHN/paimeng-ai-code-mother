package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_task_transition_event")
public class PlatformTaskTransitionEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("appId")
    private Long applicationId;

    @Column("taskId")
    private Long taskId;

    @Column("fromState")
    private String fromState;

    @Column("toState")
    private String toState;

    @Column("actorType")
    private String actorType;

    @Column("reasonCode")
    private String reasonCode;

    @Column("evidenceRef")
    private String evidenceRef;

    @Column("requestId")
    private String requestId;

    @Column("occurredTime")
    private LocalDateTime occurredAt;
}
