package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 一次受控部署（Issue #81 / T-09）
 *
 * <p>AD-016：Deployment 容器不发布宿主机端口，只在 Platform 独占的内部 Deployment network 上
 * 接受健康探测；健康通过之前不允许公开。因此 {@link #containerAddress} 只是内部网络地址，
 * 任何对外投影都不得包含它或 {@link #containerId}。
 */
@Data
@Table("platform_deployment")
public class PlatformDeployment {
    @Id(keyType = KeyType.Auto)
    private Long id;
    @Column("appId")
    private Long applicationId;
    @Column("releaseId")
    private String releaseId;
    @Column("taskId")
    private Long taskId;
    @Column("requestId")
    private String requestId;
    @Column("state")
    private String state;
    @Column("stage")
    private String stage;
    @Column("reasonCode")
    private String reasonCode;
    @Column("attemptNumber")
    private Integer attemptNumber;
    // 两个时间戳由数据库取当前值：MyBatis-Flex 会把 null 字段显式写进 INSERT，
    // 只靠列上的 DEFAULT 会直接触发 NOT NULL 违约。
    @Column(value = "requestedTime", onInsertValue = "CURRENT_TIMESTAMP(3)")
    private LocalDateTime requestedTime;
    @Column(value = "updatedTime", onInsertValue = "CURRENT_TIMESTAMP(3)")
    private LocalDateTime updatedTime;
    @Column("healthyTime")
    private LocalDateTime healthyTime;
    @Column("containerId")
    private String containerId;
    @Column("containerAddress")
    private String containerAddress;
}