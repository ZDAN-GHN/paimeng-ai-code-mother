package com.zdan.paimengaicodebackend.platform.entity;

import com.mybatisflex.annotation.Column;
import com.mybatisflex.annotation.Id;
import com.mybatisflex.annotation.KeyType;
import com.mybatisflex.annotation.Table;
import java.time.LocalDateTime;
import lombok.Data;

/**
 * 固定 Release（Issue #81 / T-09）
 *
 * <p>CT-004：Release 只做一件事——把「已验证的哪一份源码、哪一个 Profile、哪一次验证尝试」
 * 固定成一个不可变对象。没有状态列：Release 创建成功即成立，删除与修改都被数据库拒绝。
 * 部署是否健康、是否公开运行由 {@link PlatformDeployment} 独立表达，AD-011 明确两者不可合并。
 */
@Data
@Table("platform_release")
public class PlatformRelease {
    @Id(keyType = KeyType.None)
    private String id;
    @Column("appId")
    private Long applicationId;
    @Column("taskId")
    private Long taskId;
    @Column("runId")
    private String runId;
    @Column("sourceRevisionId")
    private String sourceRevisionId;
    @Column("profileVersionId")
    private Long profileVersionId;
    @Column("baselineHash")
    private String baselineHash;
    @Column("commitHash")
    private String commitHash;
    @Column("treeHash")
    private String treeHash;
    @Column("validationAttemptId")
    private String validationAttemptId;
    @Column("runtimeProfile")
    private String runtimeProfile;
    @Column(value = "createdTime", onInsertValue = "CURRENT_TIMESTAMP")
    private LocalDateTime createdAt;
}