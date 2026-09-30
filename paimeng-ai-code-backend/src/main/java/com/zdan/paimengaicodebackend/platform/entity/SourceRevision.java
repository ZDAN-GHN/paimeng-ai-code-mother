package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_source_revision")
public class SourceRevision {
    @Id(keyType = KeyType.None)
    private String id;
    @Column("appId")
    private Long applicationId;
    @Column("taskId")
    private Long taskId;
    @Column("runId")
    private String runId;
    @Column("baselineHash")
    private String baselineHash;
    @Column("baseSourceRevision")
    private String baseSourceRevision;
    @Column("commitHash")
    private String commitHash;
    @Column("treeHash")
    private String treeHash;
    @Column("profileVersionId")
    private Long profileVersionId;
    @Column("engineeringEvidenceId")
    private Long engineeringEvidenceId;
    @Column("databaseEvidenceId")
    private Long databaseEvidenceId;
    @Column("runtimeEvidenceId")
    private Long runtimeEvidenceId;
    @Column("taskAcceptanceEvidenceId")
    private Long taskAcceptanceEvidenceId;
    @Column("validationAttemptId")
    private String validationAttemptId;
    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;
}
