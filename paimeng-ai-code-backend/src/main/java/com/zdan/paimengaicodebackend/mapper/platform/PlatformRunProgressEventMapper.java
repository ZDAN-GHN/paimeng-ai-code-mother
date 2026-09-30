package com.zdan.paimengaicodebackend.mapper.platform;

import com.zdan.paimengaicodebackend.platform.entity.PlatformRunProgressEvent;
import com.mybatisflex.core.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

/** Owner 安全进度事件的只追加读取；写入一律经 {@code PlatformRunProgressService}。 */
@Mapper
public interface PlatformRunProgressEventMapper extends BaseMapper<PlatformRunProgressEvent> {

    @Select("""
        SELECT id, appId, taskId, runId, stage, note, occurredTime
        FROM platform_run_progress_event
        WHERE appId = #{appId} AND taskId = #{taskId}
        ORDER BY id DESC LIMIT 1
        """)
    PlatformRunProgressEvent selectLatest(@Param("appId") long appId, @Param("taskId") long taskId);
}
