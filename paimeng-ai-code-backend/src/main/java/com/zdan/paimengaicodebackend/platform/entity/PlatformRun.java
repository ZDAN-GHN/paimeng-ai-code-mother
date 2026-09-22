package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_run")
public class PlatformRun {

    @Id(keyType = KeyType.None)
    private String id;

    @Column("appId")
    private Long applicationId;

    @Column("taskId")
    private Long taskId;

    private String state;

    @Column("attemptNumber")
    private Integer attemptNumber;

    @Column("startedTime")
    private LocalDateTime startedAt;

    @Column("finishedTime")
    private LocalDateTime finishedAt;

    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;

    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP", onUpdateValue = "CURRENT_TIMESTAMP")
    private LocalDateTime updatedAt;
}
