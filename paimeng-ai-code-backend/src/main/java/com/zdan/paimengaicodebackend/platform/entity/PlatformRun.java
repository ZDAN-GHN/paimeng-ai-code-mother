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

    @Column("application_id")
    private Long applicationId;

    @Column("task_id")
    private Long taskId;

    private String state;

    @Column("attempt_number")
    private Integer attemptNumber;

    @Column("started_at")
    private LocalDateTime startedAt;

    @Column("finished_at")
    private LocalDateTime finishedAt;

    @Column("created_at")
    private LocalDateTime createdAt;

    @Column("updated_at")
    private LocalDateTime updatedAt;
}
