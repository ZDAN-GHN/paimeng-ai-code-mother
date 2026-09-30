package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.core.keygen.KeyGenerators;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;

/**
 * 归一化队列行（Issue #80 / T-08）
 * <p>
 * 一条不可变 Requirement 对应一行；Owner 的澄清答复是新的 Requirement，因此重新归一化
 * 追加新行而不是改写旧行，旧行作为阻断证据保留。
 */
@Table("platform_normalization_queue")
public class PlatformNormalizationQueue {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    @Column("id")
    private Long id;

    @Column("appId")
    private Long appId;
    @Column("requirementId")
    private Long requirementId;
    @Column("taskId")
    private Long taskId;
    @Column("state")
    private String state;
    @Column("attemptId")
    private String attemptId;
    @Column("attemptNumber")
    private Integer attemptNumber;
    @Column("leasedUntil")
    private LocalDateTime leasedUntil;
    @Column("resultCode")
    private String resultCode;
    @Column("createdTime")
    private LocalDateTime createdTime;
    @Column("updatedTime")
    private LocalDateTime updatedTime;

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

    public Long getRequirementId() {
        return requirementId;
    }

    public void setRequirementId(Long requirementId) {
        this.requirementId = requirementId;
    }

    public Long getTaskId() {
        return taskId;
    }

    public void setTaskId(Long taskId) {
        this.taskId = taskId;
    }

    public String getState() {
        return state;
    }

    public void setState(String state) {
        this.state = state;
    }

    public String getAttemptId() {
        return attemptId;
    }

    public void setAttemptId(String attemptId) {
        this.attemptId = attemptId;
    }

    public Integer getAttemptNumber() {
        return attemptNumber;
    }

    public void setAttemptNumber(Integer attemptNumber) {
        this.attemptNumber = attemptNumber;
    }

    public LocalDateTime getLeasedUntil() {
        return leasedUntil;
    }

    public void setLeasedUntil(LocalDateTime leasedUntil) {
        this.leasedUntil = leasedUntil;
    }

    public String getResultCode() {
        return resultCode;
    }

    public void setResultCode(String resultCode) {
        this.resultCode = resultCode;
    }

    public LocalDateTime getCreatedTime() {
        return createdTime;
    }

    public void setCreatedTime(LocalDateTime createdTime) {
        this.createdTime = createdTime;
    }

    public LocalDateTime getUpdatedTime() {
        return updatedTime;
    }

    public void setUpdatedTime(LocalDateTime updatedTime) {
        this.updatedTime = updatedTime;
    }
}
