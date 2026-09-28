package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_candidate_source_snapshot")
public class CandidateSourceSnapshot {
    @Id(keyType = KeyType.None)
    @Column("runId")
    private String runId;
    @Column("appId")
    private Long applicationId;
    @Column("taskId")
    private Long taskId;
    @Column("requestId")
    private String requestId;
    @Column("fenceToken")
    private Long fenceToken;
    @Column("baselineHash")
    private String baselineHash;
    @Column("baseSourceRevision")
    private String baseSourceRevision;
    private String status;
    @Column("commitHash")
    private String commitHash;
    @Column("treeHash")
    private String treeHash;
    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;
    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
    private LocalDateTime updatedAt;
}
