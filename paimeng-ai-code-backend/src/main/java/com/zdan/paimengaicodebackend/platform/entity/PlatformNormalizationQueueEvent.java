package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.core.keygen.KeyGenerators;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;

/** 归一化队列的只追加审计；写入方必须与队列行处于同一事务。 */
@Table("platform_normalization_queue_event")
public class PlatformNormalizationQueueEvent {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    @Column("id")
    private Long id;
    @Column("queueId")
    private Long queueId;
    @Column("taskId")
    private Long taskId;
    @Column("attemptId")
    private String attemptId;
    @Column("fromState")
    private String fromState;
    @Column("toState")
    private String toState;
    @Column("reasonCode")
    private String reasonCode;
    @Column("occurredTime")
    private LocalDateTime occurredTime;

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public Long getQueueId() {
        return queueId;
    }

    public void setQueueId(Long queueId) {
        this.queueId = queueId;
    }

    public Long getTaskId() {
        return taskId;
    }

    public void setTaskId(Long taskId) {
        this.taskId = taskId;
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

    public LocalDateTime getOccurredTime() {
        return occurredTime;
    }

    public void setOccurredTime(LocalDateTime occurredTime) {
        this.occurredTime = occurredTime;
    }
}
