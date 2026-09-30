package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformNormalizationQueue;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 归一化队列数据访问（Issue #80 / T-08）
 * <p>
 * 与验证队列同样只走 MyBatis：本项目的 {@code @Transactional} 由 MyBatis-Flex 驱动，
 * 另开连接会让队列写入脱离 Task 状态转换。
 */
@Mapper
public interface PlatformNormalizationQueueMapper extends BaseMapper<PlatformNormalizationQueue> {

    /** 领取一条待归一化或租约已过期的请求；SKIP LOCKED 保证多 Runtime 并发安全 */
    @Select("""
        SELECT id, appId, requirementId, taskId, attemptId, attemptNumber
        FROM platform_normalization_queue
        WHERE BINARY state = BINARY 'PENDING'
           OR (BINARY state = BINARY 'RUNNING' AND leasedUntil < CURRENT_TIMESTAMP(3))
        ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    PlatformNormalizationQueue selectClaimable();

    /** 领取的乐观 CAS：租期与尝试身份一起写入，租约过期后旧 attempt 不能再回写 */
    @Update("""
        UPDATE platform_normalization_queue
        SET state = 'RUNNING', attemptId = #{attemptId}, attemptNumber = #{attemptNumber},
            leasedUntil = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE), resultCode = NULL
        WHERE id = #{id}
        """)
    int claim(@Param("id") long id,
              @Param("attemptId") String attemptId,
              @Param("attemptNumber") int attemptNumber);

    /** 结算的 CAS 必须同时匹配队列行、当前 attempt、运行态与未过期租约 */
    @Update("""
        UPDATE platform_normalization_queue
        SET state = #{state}, resultCode = #{resultCode}, leasedUntil = NULL
        WHERE id = #{id} AND taskId = #{taskId}
          AND BINARY attemptId = BINARY #{attemptId}
          AND BINARY state = BINARY 'RUNNING' AND leasedUntil > CURRENT_TIMESTAMP(3)
        """)
    int settle(@Param("id") long id,
               @Param("taskId") long taskId,
               @Param("attemptId") String attemptId,
               @Param("state") String state,
               @Param("resultCode") String reasonCode);
}
