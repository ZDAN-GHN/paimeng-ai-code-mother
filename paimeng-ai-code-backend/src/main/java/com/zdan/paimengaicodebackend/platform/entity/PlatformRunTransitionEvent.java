package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_run_transition_event")
public class PlatformRunTransitionEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("application_id")
    private Long applicationId;

    @Column("run_id")
    private String runId;

    @Column("from_state")
    private String fromState;

    @Column("to_state")
    private String toState;

    @Column("actor_type")
    private String actorType;

    @Column("reason_code")
    private String reasonCode;

    @Column("evidence_ref")
    private String evidenceRef;

    @Column("request_id")
    private String requestId;

    @Column("occurred_at")
    private LocalDateTime occurredAt;
}
