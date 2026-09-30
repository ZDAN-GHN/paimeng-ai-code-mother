package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.core.keygen.KeyGenerators;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;

/**
 * Owner 安全的执行进度阶段（Issue #80 / T-08）
 * <p>
 * 只承载粗粒度阶段与一句说明。Agent 的工具名、参数、Pi Session、Sandbox 标识和任何生产
 * 信息都不允许进入本表：它是 Owner 状态投影的数据来源。
 */
@Table("platform_run_progress_event")
public class PlatformRunProgressEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    @Column("id")
    private Long id;
    @Column("appId")
    private Long appId;
    @Column("taskId")
    private Long taskId;
    @Column("runId")
    private String runId;
    @Column("stage")
    private String stage;
    @Column("note")
    private String note;
    @Column("occurredTime")
    private LocalDateTime occurredTime;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getAppId() {
        return appId;
    }

    public void setAppId(Long appId) {
        this.appId = appId;
    }

    public Long getTaskId() {
        return taskId;
    }

    public void setTaskId(Long taskId) {
        this.taskId = taskId;
    }

    public String getRunId() {
        return runId;
    }

    public void setRunId(String runId) {
        this.runId = runId;
    }

    public String getStage() {
        return stage;
    }

    public void setStage(String stage) {
        this.stage = stage;
    }

    public String getNote() {
        return note;
    }

    public void setNote(String note) {
        this.note = note;
    }

    public LocalDateTime getOccurredTime() {
        return occurredTime;
    }

    public void setOccurredTime(LocalDateTime occurredTime) {
        this.occurredTime = occurredTime;
    }
}
