package com.zdan.paimengaicodebackend.mapper.platform;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRelease;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * Release 数据访问（Issue #81 / T-09）
 *
 * <p>必须走 MyBatis 而不是 JdbcTemplate：本项目的 {@code @Transactional} 由 MyBatis-Flex 的
 * 事务管理器驱动，JdbcTemplate 会另开连接，导致 Release 写入无法随 Task 状态转换一起回滚。
 */
@Mapper
public interface PlatformReleaseMapper extends BaseMapper<PlatformRelease> {

    @Select("""
        SELECT id FROM platform_release
        WHERE appId = #{appId} AND BINARY sourceRevisionId = BINARY #{sourceRevisionId}
        """)
    String selectIdByRevision(@Param("appId") long applicationId,
                             @Param("sourceRevisionId") String sourceRevisionId);

    /**
     * 该 Task 是否恰好拥有一个 Release。
     *
     * <p>「首次发布」这个前置条件必须来自持久事实而非调用方自报：恰好一个说明这个版本已固定，
     * 零个说明 Release 还没创建，多于一个说明唯一键已被绕过。
     */
    @Select("""
        SELECT COUNT(*) FROM platform_release
        WHERE appId = #{appId} AND taskId = #{taskId}
        """)
    int countForTask(@Param("appId") long applicationId, @Param("taskId") long taskId);

    /**
     * 该 Application 是否存在属于其他 Task 的 Release。
     *
     * <p>AD-011：首次 validated 版本自动发布，之后的版本必须由 Owner 确认。只要历史上出现过
     * 别的 Release，当前这个版本就不再是首次，不能走自动发布。
     */
    @Select("""
        SELECT COUNT(*) FROM platform_release
        WHERE appId = #{appId} AND taskId <> #{taskId}
        """)
    int countForOtherTasks(@Param("appId") long applicationId, @Param("taskId") long taskId);
}