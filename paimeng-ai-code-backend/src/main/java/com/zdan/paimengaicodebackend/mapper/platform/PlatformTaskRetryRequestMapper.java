package com.zdan.paimengaicodebackend.mapper.platform;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTaskRetryRequest;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/**
 * Owner 重试请求的数据访问（Issue #80 / Slice 2）
 * <p>
 * 与归一化队列一样只走 MyBatis：{@code @Transactional} 由 MyBatis-Flex 驱动，
 * 「重试事实落库」与「{@code failed -> ready} 转换」必须在同一事务，否则会出现
 * 状态已回到 ready、却查不到任何 Owner 请求的悬空状态。
 */
@Mapper
public interface PlatformTaskRetryRequestMapper extends BaseMapper<PlatformTaskRetryRequest> {

    /**
     * 该 Task 是否存在已被 Platform 受理的 Owner 重试请求。
     *
     * <p>只统计已受理的事实：本表的写入方在同事务内先插行、再转换状态，
     * 因此查到行就等于 Platform 已经接受过一次 Owner 重试。
     */
    @Select("SELECT COUNT(*) FROM platform_task_retry_request WHERE taskId = #{taskId}")
    int countAcceptedForTask(@Param("taskId") long taskId);
}
