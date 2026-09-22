package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTrustedProfileVersionMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplication;
import org.springframework.stereotype.Component;

@Component
public class PlatformLogicalRelationValidator {

    private final PlatformApplicationMapper applicationMapper;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformTaskMapper taskMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformTrustedProfileVersionMapper profileVersionMapper;

    public PlatformLogicalRelationValidator(
        PlatformApplicationMapper applicationMapper,
        PlatformRequirementMapper requirementMapper,
        PlatformTaskMapper taskMapper,
        PlatformRunMapper runMapper,
        PlatformTrustedProfileVersionMapper profileVersionMapper
    ) {
        this.applicationMapper = applicationMapper;
        this.requirementMapper = requirementMapper;
        this.taskMapper = taskMapper;
        this.runMapper = runMapper;
        this.profileVersionMapper = profileVersionMapper;
    }

    public PlatformApplication requireActiveApplication(Long applicationId) {
        PlatformApplication application = applicationMapper.selectOneByQuery(
            QueryWrapper.create().eq("id", applicationId).eq("is_deleted", 0)
        );
        if (application == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在或已归档");
        }
        return application;
    }

    public void requireRequirementBelongsToApplication(Long applicationId, Long requirementId) {
        requireBelongs(
            requirementMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", requirementId).eq("application_id", applicationId)
            ),
            "Requirement 不属于 Application"
        );
    }

    public void requireTaskBelongsToApplication(Long applicationId, Long taskId) {
        requireBelongs(
            taskMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", taskId).eq("application_id", applicationId)
            ),
            "Task 不属于 Application"
        );
    }

    public void requireRunBelongsToApplication(Long applicationId, String runId) {
        requireBelongs(
            runMapper.selectCountByQuery(
                QueryWrapper.create().eq("id", runId).eq("application_id", applicationId)
            ),
            "Run 不属于 Application"
        );
    }

    public void requireProfileVersionBelongsToApplication(Long applicationId, Long versionNumber) {
        requireBelongs(
            profileVersionMapper.selectCountByQuery(
                QueryWrapper.create()
                    .eq("application_id", applicationId)
                    .eq("version_number", versionNumber)
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
