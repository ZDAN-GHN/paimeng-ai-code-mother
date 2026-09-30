package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface PlatformRunMapper extends BaseMapper<PlatformRun> {

    /**
     * 领取一个待启动的受控 Run（Issue #80 / T-08）。
     *
     * <p>只有 {@code READY} 的 Task 才允许被启动，因此这里是 Runtime 唯一的取活入口：
     * Agent 不能凭空指定一个 RunId 让 Platform 执行。
     */
    @Select("""
        SELECT r.id, r.appId, r.taskId, r.state, r.attemptNumber, r.startedTime, r.finishedTime,
               r.createdTime, r.updatedTime
        FROM platform_run r
        JOIN platform_task t ON t.id = r.taskId
        WHERE BINARY r.state = BINARY 'CREATED' AND BINARY t.state = BINARY 'READY'
        ORDER BY r.createdTime, r.id LIMIT 1 FOR UPDATE SKIP LOCKED
        """)
    PlatformRun selectStartableRun();

    /** Owner 状态投影使用：Task 最近一次 Run 的公开标识。 */
    @Select("""
        SELECT id, appId, taskId, state, attemptNumber, startedTime, finishedTime, createdTime, updatedTime
        FROM platform_run
        WHERE taskId = #{taskId}
        ORDER BY attemptNumber DESC LIMIT 1
        """)
    PlatformRun selectLatestForTask(@Param("taskId") long taskId);
}
