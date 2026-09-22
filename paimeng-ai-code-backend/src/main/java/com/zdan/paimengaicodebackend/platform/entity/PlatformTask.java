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

    @Column("appId")
    private Long applicationId;

    @Column("requirementId")
    private Long requirementId;

    @Column("parentTaskId")
    private Long parentTaskId;

    private String state;

    @Column("blockedQuestion")
    private String blockedQuestion;

    @Column("baselineSchemaVersion")
    private Integer baselineSchemaVersion;

    @Column("baseProfileVersion")
    private Long baseProfileVersion;

    @Column("baseSourceRevision")
    private String baseSourceRevision;

    @Column("requestedOutcome")
    private String requestedOutcome;

    @Column("acceptanceTarget")
    private String acceptanceTarget;

    @Column("baselineJson")
    private String baselineJson;

    @Column("failureCode")
    private String failureCode;

    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;

    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
    private LocalDateTime updatedAt;
}
