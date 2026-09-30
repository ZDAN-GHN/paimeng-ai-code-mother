package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformValidationQueue;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/**
 * 验证队列数据访问
 * <p>
 * 必须走 MyBatis 而不是 JdbcTemplate：本项目的 {@code @Transactional} 由 MyBatis-Flex 的
 * 事务管理器驱动，JdbcTemplate 会另开连接，导致队列写入无法随 Run 转换一起回滚。
 */
@Mapper
public interface PlatformValidationQueueMapper extends BaseMapper<PlatformValidationQueue> {

    /** 领取一条待验证或租约已过期的请求；行锁由 SKIP LOCKED 保证多消费者安全 */
    @Select("""
        SELECT eventId, appId, runId, attemptId, attemptNumber
        FROM platform_validation_queue
        WHERE BINARY state = BINARY 'PENDING'
           OR (BINARY state = BINARY 'RUNNING' AND leasedUntil < CURRENT_TIMESTAMP(3))
        ORDER BY eventId LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    PlatformValidationQueue selectClaimable();

    /** 领取后的乐观 CAS：同时把旧 attemptId 作为审计留痕写回 */
    @Update("""
        UPDATE platform_validation_queue
        SET state = 'RUNNING', attemptId = #{attemptId}, attemptNumber = #{attemptNumber},
            leasedUntil = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE), resultCode = NULL
        WHERE eventId = #{eventId}
        """)
    int claim(@Param("eventId") long eventId,
              @Param("attemptId") String attemptId,
              @Param("attemptNumber") int attemptNumber);

    /** 完成前的 CAS 必须同时匹配 Run、attempt、运行态与未过期租约 */
    @Update("""
        UPDATE platform_validation_queue
        SET state = #{state}, resultCode = #{resultCode}, leasedUntil = NULL
        WHERE eventId = #{eventId} AND BINARY runId = BINARY #{runId}
          AND BINARY attemptId = BINARY #{attemptId}
          AND BINARY state = BINARY 'RUNNING' AND leasedUntil > CURRENT_TIMESTAMP(3)
        """)
    int complete(@Param("eventId") long eventId,
                 @Param("runId") String runId,
                 @Param("attemptId") String attemptId,
                 @Param("state") String state,
                 @Param("resultCode") String reasonCode);

    /** 晋升前的权威证明：同一 Run、同一 Platform 尝试、四类门禁各一条 PASS */
    @Select("""
        SELECT CASE WHEN COUNT(*) = 4 AND COUNT(DISTINCT BINARY category) = 4
                 AND SUM(CASE WHEN BINARY result = BINARY 'PASS'
                     AND BINARY category IN (BINARY 'ENGINEERING', BINARY 'DATABASE',
                         BINARY 'RUNTIME', BINARY 'TASK_ACCEPTANCE') THEN 1 ELSE 0 END) = 4
                THEN 1 ELSE 0 END
        FROM platform_validation_evidence
        WHERE runId = #{runId} AND BINARY issuer = BINARY 'PLATFORM_VALIDATOR_V1'
          AND BINARY attemptId = BINARY #{attemptId}
        """)
    int countAuthoritativePassEvidence(@Param("runId") String runId, @Param("attemptId") String attemptId);

    /** 晋升闸门：该 Run 必须恰好有一条 PASS，且尝试身份唯一 */
    @Select("""
        SELECT COUNT(*) FROM platform_validation_queue
        WHERE appId = #{appId} AND BINARY runId = BINARY #{runId} AND BINARY state = BINARY 'PASS'
        """)
    int countPassedAttempts(@Param("appId") long appId, @Param("runId") String runId);

    @Select("""
        SELECT attemptId FROM platform_validation_queue
        WHERE appId = #{appId} AND BINARY runId = BINARY #{runId} AND BINARY state = BINARY 'PASS'
        """)
    java.util.List<String> selectPassedAttempts(@Param("appId") long appId, @Param("runId") String runId);
}
