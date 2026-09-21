package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_task")
public class PlatformTask {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("application_id")
    private Long applicationId;

    @Column("requirement_id")
    private Long requirementId;

    @Column("parent_task_id")
    private Long parentTaskId;

    private String state;

    @Column("blocked_question")
    private String blockedQuestion;

    @Column("baseline_schema_version")
    private Integer baselineSchemaVersion;

    @Column("base_profile_version")
    private Long baseProfileVersion;

    @Column("base_source_revision")
    private String baseSourceRevision;

    @Column("requested_outcome")
    private String requestedOutcome;

    @Column("acceptance_target")
    private String acceptanceTarget;

    @Column("baseline_json")
    private String baselineJson;

    @Column("failure_code")
    private String failureCode;

    @Column("created_at")
    private LocalDateTime createdAt;

    @Column("updated_at")
    private LocalDateTime updatedAt;
}
