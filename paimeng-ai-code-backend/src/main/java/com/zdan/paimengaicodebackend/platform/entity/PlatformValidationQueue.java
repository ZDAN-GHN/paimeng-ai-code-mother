package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;

/**
 * 权威验证队列行
 * <p>
 * id 直接复用 Run 转换事件 id，由 PlatformRunTransitionService 在同一事务内写入。
 */
@Table("platform_validation_queue")
public class PlatformValidationQueue {

    @Id(value = "eventId", keyType = KeyType.None)
    @Column("eventId")
    private Long eventId;

    @Column("appId")
    private Long appId;
    @Column("runId")
    private String runId;
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

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public Long getAppId() {
        return appId;
    }

    public void setAppId(Long appId) {
        this.appId = appId;
    }

    public String getRunId() {
        return runId;
    }

    public void setRunId(String runId) {
        this.runId = runId;
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
