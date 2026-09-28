package com.zdan.paimengaicodebackend.mapper.platform;

import com.mybatisflex.core.BaseMapper;
import com.zdan.paimengaicodebackend.platform.entity.CandidateSourceSnapshot;
import org.apache.ibatis.annotations.Select;

public interface CandidateSourceSnapshotMapper extends BaseMapper<CandidateSourceSnapshot> {
    @Select("SELECT id FROM platform_run WHERE id = #{runId} FOR UPDATE")
    String lockRun(String runId);

    @Select("SELECT COUNT(*) FROM platform_run_command_request WHERE runId = #{runId} AND status = 'STARTED'")
    long countUnfinishedCommands(String runId);
}
