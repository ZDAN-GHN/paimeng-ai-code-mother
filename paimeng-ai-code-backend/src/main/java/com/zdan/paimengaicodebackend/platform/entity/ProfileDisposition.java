package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_profile_disposition")
public class ProfileDisposition {
    @Id(keyType = KeyType.None)
    @Column("runId")
    private String runId;
    @Column("appId")
    private Long applicationId;
    @Column("taskId")
    private Long taskId;
    @Column("baselineHash")
    private String baselineHash;
    @Column("baseSourceRevision")
    private String baseSourceRevision;
    @Column("commitHash")
    private String commitHash;
    @Column("treeHash")
    private String treeHash;
    private String disposition;
    @Column("diffJson")
    private String diffJson;
    @Column("requirementId")
    private Long requirementId;
    private String reason;
    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;
}
