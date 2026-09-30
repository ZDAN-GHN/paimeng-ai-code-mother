package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import com.mybatisflex.core.keygen.KeyGenerators;
import java.time.LocalDateTime;

/**
 * Owner 显式重试请求（Issue #80 / Slice 2）
 * <p>
 * 只追加。D-06 的 {@code failed -> ready} 以前靠调用方布尔自报「Owner 已请求重试」，
 * 任何内部调用方都能伪造；本行让这条前置条件变成 Platform 可实查的事实。
 *
 * @param actorType 发起重试的主体；D-06 只承认 Owner 与 System Administrator
 */
@Table("platform_task_retry_request")
public class PlatformTaskRetryRequest {

    @Id(keyType = KeyType.Generator, value = KeyGenerators.snowFlakeId)
    @Column("id")
    private Long id;
    @Column("appId")
    private Long appId;
    @Column("taskId")
    private Long taskId;
    @Column("requestId")
    private String requestId;
    @Column("actorType")
    private String actorType;
    @Column("reason")
    private String reason;
    @Column("createdTime")
    private LocalDateTime createdTime;

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

    public String getRequestId() {
        return requestId;
    }

    public void setRequestId(String requestId) {
        this.requestId = requestId;
    }

    public String getActorType() {
        return actorType;
    }

    public void setActorType(String actorType) {
        this.actorType = actorType;
    }

    public String getReason() {
        return reason;
    }

    public void setReason(String reason) {
        this.reason = reason;
    }

    public LocalDateTime getCreatedTime() {
        return createdTime;
    }

    public void setCreatedTime(LocalDateTime createdTime) {
        this.createdTime = createdTime;
    }
}
