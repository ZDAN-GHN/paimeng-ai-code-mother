package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_run_recovery_checkpoint")
public class PlatformRunRecoveryCheckpoint {

    @Id(keyType = KeyType.None)
    @Column("runId")
    private String runId;

    @Column("appId")
    private Long applicationId;

    @Column("fenceToken")
    private Long fenceToken;

    @Column("containerId")
    private String containerId;

    private String phase;

    @Column("preparedRequestId")
    private String preparedRequestId;

    @Column("beginRequestId")
    private String beginRequestId;

    @Column("resumeRequestId")
    private String resumeRequestId;

    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;

    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
    private LocalDateTime updatedAt;
}
