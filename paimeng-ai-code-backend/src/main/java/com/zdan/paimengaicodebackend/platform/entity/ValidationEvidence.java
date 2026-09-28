package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_validation_evidence")
public class ValidationEvidence {
    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;
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
    private String category;
    private String result;
    @Column("payloadJson")
    private String payloadJson;
    @Column("payloadSha256")
    private String payloadSha256;
    @Column("artifactRef")
    private String artifactRef;
    @Column("artifactCommitHash")
    private String artifactCommitHash;
    @Column("artifactSha256")
    private String artifactSha256;
    @Column("idempotencyKey")
    private String idempotencyKey;
    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;
}
