package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTrustedProfileVersionMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import org.springframework.stereotype.Component;

@Component
public class PlatformLogicalRelationValidator {

    private final AppMapper appMapper;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformTaskMapper taskMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformTrustedProfileVersionMapper profileVersionMapper;

    public PlatformLogicalRelationValidator(
        AppMapper appMapper,
        PlatformRequirementMapper requirementMapper,
        PlatformTaskMapper taskMapper,
        PlatformRunMapper runMapper,
        PlatformTrustedProfileVersionMapper profileVersionMapper
    ) {
        this.appMapper = appMapper;
        this.requirementMapper = requirementMapper;
        this.taskMapper = taskMapper;
        this.runMapper = runMapper;
        this.profileVersionMapper = profileVersionMapper;
    }

    public App requireActiveApplication(Long applicationId) {
        App application = appMapper.selectOneByQuery(
            QueryWrapper.create()
                .eq("id", applicationId)
                .eq("isDelete", 0)
                .eq("lifecycleStatus", "ACTIVE")
        );
        if (application == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在或已归档");
        }
        return application;
    }

    public void requireRequirementBelongsToApplication(Long applicationId, Long requirementId) {
        requireBelongs(
            requirementMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", requirementId).eq("appId", applicationId)
            ),
            "Requirement 不属于 Application"
        );
    }

    public void requireTaskBelongsToApplication(Long applicationId, Long taskId) {
        requireBelongs(
            taskMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", taskId).eq("appId", applicationId)
            ),
            "Task 不属于 Application"
        );
    }

    public void requireRunBelongsToApplication(Long applicationId, String runId) {
        requireBelongs(
            runMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", runId).eq("appId", applicationId)
            ),
            "Run 不属于 Application"
        );
    }

    public void requireProfileVersionBelongsToApplication(Long applicationId, Long versionNumber) {
        requireBelongs(
            profileVersionMapper.selectCountByQuery(
                QueryWrapper.create()
                    .eq("appId", applicationId)
                    .eq("versionNumber", versionNumber)
            ),
            "Trusted Profile Version 不属于 Application"
        );
    }

    private void requireBelongs(long count, String message) {
        if (count != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, message);
        }
    }
}
