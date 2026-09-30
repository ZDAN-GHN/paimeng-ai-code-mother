package com.zdan.paimengaicodebackend.mapper.platform;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformDeployment;
import java.time.LocalDateTime;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * Deployment 数据访问（Issue #81 / T-09）
 *
 * <p>领取沿用验证队列的 {@code FOR UPDATE SKIP LOCKED} 写法：多个 Platform 实例同时轮询时
 * 不会互相阻塞，也不会把同一次部署跑两遍。所有状态推进都必须带 CAS 条件，调用方不能声称
 * 自己处在某个状态。
 */
@Mapper
public interface PlatformDeploymentMapper extends BaseMapper<PlatformDeployment> {

    @Select("""
        SELECT id FROM platform_deployment
        WHERE BINARY state = BINARY 'PENDING'
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    Long selectClaimableId();

    /** 领取是唯一一次离开 PENDING 的机会；返回 0 表示已被其他实例抢走。 */
    @Update("""
        UPDATE platform_deployment
        SET state = 'PROVISIONING', stage = 'PROVISIONING',
            attemptNumber = attemptNumber + 1, updatedTime = CURRENT_TIMESTAMP(3)
        WHERE id = #{id} AND BINARY state = BINARY 'PENDING'
        """)
    int claim(@Param("id") long id);

    /**
     * 回收僵死的 PROVISIONING。
     *
     * <p>Platform 进程可能在容器已启动、状态未落库时被终止。没有这条回收，第一次部署失败会
     * 让 Application 永远停在「正在准备上线」。回收只回到 PENDING，不复用旧容器：执行器按
     * Release 标签查找并重建，避免两个实例同时服务同一路径。
     */
    @Update("""
        UPDATE platform_deployment
        SET state = 'PENDING', stage = 'RELEASED', reasonCode = NULL,
            containerId = NULL, containerAddress = NULL, updatedTime = CURRENT_TIMESTAMP(3)
        WHERE BINARY state = BINARY 'PROVISIONING' AND updatedTime < #{staleBefore}
        """)
    int reclaimStale(@Param("staleBefore") LocalDateTime staleBefore);

    @Update("""
        UPDATE platform_deployment
        SET state = 'HEALTHY', stage = 'HEALTHY', reasonCode = NULL,
            containerId = #{containerId}, containerAddress = #{containerAddress},
            healthyTime = CURRENT_TIMESTAMP(3), updatedTime = CURRENT_TIMESTAMP(3)
        WHERE id = #{id} AND BINARY state = BINARY 'PROVISIONING'
        """)
    int markHealthy(@Param("id") long id,
                    @Param("containerId") String containerId,
                    @Param("containerAddress") String containerAddress);

    @Update("""
        UPDATE platform_deployment
        SET state = 'UNHEALTHY', stage = #{stage}, reasonCode = #{reasonCode},
            containerId = #{containerId}, containerAddress = #{containerAddress},
            updatedTime = CURRENT_TIMESTAMP(3)
        WHERE id = #{id} AND BINARY state = BINARY 'PROVISIONING'
        """)
    int markUnhealthy(@Param("id") long id,
                      @Param("stage") String stage,
                      @Param("reasonCode") String reasonCode,
                      @Param("containerId") String containerId,
                      @Param("containerAddress") String containerAddress);

    @Select("""
        SELECT id, appId, releaseId, taskId, requestId, state, stage, reasonCode, attemptNumber,
               requestedTime, updatedTime, healthyTime, containerId, containerAddress
        FROM platform_deployment
        WHERE appId = #{appId} AND BINARY state = BINARY 'HEALTHY'
        ORDER BY id DESC LIMIT 1
        """)
    PlatformDeployment selectHealthyForApplication(@Param("appId") long applicationId);

    /** AD-017 的 404/503 判定依赖「是否曾经健康」，因此这个事实必须可单独查询。 */
    @Select("""
        SELECT COUNT(*) FROM platform_deployment
        WHERE appId = #{appId} AND healthyTime IS NOT NULL
        """)
    int countEverHealthy(@Param("appId") long applicationId);

    @Select("""
        SELECT id, appId, releaseId, taskId, requestId, state, stage, reasonCode, attemptNumber,
               requestedTime, updatedTime, healthyTime, containerId, containerAddress
        FROM platform_deployment
        WHERE appId = #{appId} AND BINARY state IN (BINARY 'PENDING', BINARY 'PROVISIONING')
        ORDER BY id DESC LIMIT 1
        """)
    PlatformDeployment selectActiveForApplication(@Param("appId") long applicationId);

    /** 最近一次部署尝试，Owner 受控诊断的唯一来源；未健康时用它解释「为什么没上线」。 */
    @Select("""
        SELECT id, appId, releaseId, taskId, requestId, state, stage, reasonCode, attemptNumber,
               requestedTime, updatedTime, healthyTime, containerId, containerAddress
        FROM platform_deployment
        WHERE appId = #{appId}
        ORDER BY id DESC LIMIT 1
        """)
    PlatformDeployment selectLatestForApplication(@Param("appId") long applicationId);
}