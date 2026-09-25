package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;
import lombok.Data;

@Data
@Table("platform_run_command_request")
public class PlatformRunCommandRequest {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    private Long id;

    @Column("appId")
    private Long applicationId;

    @Column("runId")
    private String runId;

    @Column("requestId")
    private String requestId;

    @Column("fenceToken")
    private Long fenceToken;

    @Column("commandHash")
    private String commandHash;

    private String status;

    @Column("exitCode")
    private Integer exitCode;

    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;

    @Column("finishedTime")
    private LocalDateTime finishedAt;
}
