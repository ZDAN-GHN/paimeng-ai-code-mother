package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface PlatformTaskMapper extends BaseMapper<PlatformTask> {

    /** Owner 状态投影只关心最近一个 Task：更早的 Task 是历史证据，不是当前状态。 */
    @Select("""
        SELECT id, appId, requirementId, parentTaskId, state, blockedQuestion, baselineSchemaVersion,
               baseProfileVersion, baseSourceRevision, requestedOutcome, acceptanceTarget, baselineJson,
               failureCode, createdTime, updatedTime
        FROM platform_task
        WHERE appId = #{appId}
        ORDER BY createdTime DESC, id DESC LIMIT 1
        """)
    PlatformTask selectLatestForApplication(@Param("appId") long appId);

    /**
     * Owner 答复后清空待答问题。
     *
     * <p>问题本身留在 Task 转换事件与归一化队列事件里；这里只保证 Owner 视图不会把
     * 已答复的问题继续显示为「待确认」。CAS 绑定 {@code CREATED}，避免与重新阻断竞争。
     */
    @Update("UPDATE platform_task SET blockedQuestion = NULL WHERE id = #{id} AND state = 'CREATED'")
    int clearBlockingQuestion(@Param("id") long id);
}
