package com.zdan.paimengaicodebackend.mapper.platform;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunLease;
import java.time.LocalDateTime;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

public interface PlatformRunLeaseMapper extends BaseMapper<PlatformRunLease> {
    @Select("SELECT fenceToken FROM platform_run_lease WHERE runId = #{runId} "
        + "AND fenceToken = #{fence} AND expiresTime >= #{checkedAt} FOR UPDATE")
    Long lockActiveFence(@Param("runId") String runId, @Param("fence") long fence,
                         @Param("checkedAt") LocalDateTime checkedAt);
}
