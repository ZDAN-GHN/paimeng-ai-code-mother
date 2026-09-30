package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;

/**
 * 验证队列的只追加审计事件
 * <p>
 * 自增主键由数据库生成，写入方必须与队列行处于同一事务。
 */
@Table("platform_validation_queue_event")
public class PlatformValidationQueueEvent {

    @Id(value = "id", keyType = KeyType.Auto)
    @Column("id")
    private Long id;

    @Column("eventId")
    private Long eventId;
    @Column("runId")
    private String runId;
    @Column("attemptId")
    private String attemptId;
    @Column("fromState")
    private String fromState;
    @Column("toState")
    private String toState;
    @Column("reasonCode")
    private String reasonCode;
    @Column("occurredAt")
    private LocalDateTime occurredAt;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getEventId() {
        return eventId;
    }

    public void setEventId(Long eventId) {
        this.eventId = eventId;
    }

    public String getRunId() {
        return runId;
    }

    public void setRunId(String runId) {
        this.runId = runId;
    }

    public String getAttemptId() {
        return attemptId;
    }

    public void setAttemptId(String attemptId) {
        this.attemptId = attemptId;
    }

    public String getFromState() {
        return fromState;
    }

    public void setFromState(String fromState) {
        this.fromState = fromState;
    }

    public String getToState() {
        return toState;
    }

    public void setToState(String toState) {
        this.toState = toState;
    }

    public String getReasonCode() {
        return reasonCode;
    }

    public void setReasonCode(String reasonCode) {
        this.reasonCode = reasonCode;
    }

    public LocalDateTime getOccurredAt() {
        return occurredAt;
    }

    public void setOccurredAt(LocalDateTime occurredAt) {
        this.occurredAt = occurredAt;
    }
}
