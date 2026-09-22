package com.zdan.paimengaicodebackend.platform.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationArchiveService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplication;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlatformApplicationManagementService {

    private static final String PENDING_NORMALIZATION = "PENDING_NORMALIZATION";

    private final PlatformApplicationMapper applicationMapper;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformApplicationArchiveService archiveService;

    public PlatformApplicationManagementService(
        PlatformApplicationMapper applicationMapper,
        PlatformRequirementMapper requirementMapper,
        PlatformLogicalRelationValidator relationValidator,
        PlatformApplicationArchiveService archiveService
    ) {
        this.applicationMapper = applicationMapper;
        this.requirementMapper = requirementMapper;
        this.relationValidator = relationValidator;
        this.archiveService = archiveService;
    }

    @Transactional(rollbackFor = Exception.class)
    public PlatformApplicationVO createApplication(User actor, String name) {
        requireText(name, "Application 名称不能为空");
        Long actorId = requireActorId(actor);

        PlatformApplication application = new PlatformApplication();
        application.setOwnerId(actorId);
        application.setName(name.trim());
        application.setIsDeleted(0);
        applicationMapper.insertSelective(application);
        return toApplicationVO(application, false);
    }

    public PlatformApplicationVO getApplication(Long applicationId, User actor) {
        return toApplicationVO(requireAuthorizedActiveApplication(applicationId, actor), false);
    }

    @Transactional(rollbackFor = Exception.class)
    public PlatformRequirementVO submitRequirement(
        Long applicationId,
        User actor,
        String originalText
    ) {
        requireText(originalText, "Requirement 原文不能为空");
        requireAuthorizedActiveApplication(applicationId, actor);

        PlatformRequirement requirement = new PlatformRequirement();
        requirement.setApplicationId(applicationId);
        requirement.setKind("OWNER_REQUEST");
        requirement.setOriginalText(originalText);
        requirementMapper.insertSelective(requirement);
        return toRequirementVO(requirement);
    }

    public PlatformRequirementVO getRequirement(Long applicationId, Long requirementId, User actor) {
        requireAuthorizedActiveApplication(applicationId, actor);
        PlatformRequirement requirement = requirementMapper.selectOneByQuery(
            QueryWrapper.create().eq("id", requirementId).eq("application_id", applicationId)
        );
        if (requirement == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Requirement 不存在");
        }
        return toRequirementVO(requirement);
    }

    public PlatformApplicationVO archiveApplication(Long applicationId, User actor) {
        PlatformApplication application = requireAuthorizedActiveApplication(applicationId, actor);
        Long actorId = requireActorId(actor);
        PlatformApplication archivedApplication = archiveService.archive(
            applicationId,
            actorId,
            actorFor(actor),
            "ARCHIVE_REQUEST",
            UUID.randomUUID().toString()
        );
        return toApplicationVO(archivedApplication, true);
    }

    private PlatformApplication requireAuthorizedActiveApplication(Long applicationId, User actor) {
        if (applicationId == null || applicationId <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application ID 无效");
        }
        PlatformApplication application = relationValidator.requireActiveApplication(applicationId);
        if (
            actorFor(actor) == PlatformActor.OWNER &&
            !requireActorId(actor).equals(application.getOwnerId())
        ) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权管理该 Application");
        }
        return application;
    }

    private PlatformActor actorFor(User actor) {
        requireActorId(actor);
        return UserConstant.ADMIN_ROLE.equals(actor.getUserRole())
            ? PlatformActor.SYSTEM_ADMINISTRATOR
            : PlatformActor.OWNER;
    }

    private Long requireActorId(User actor) {
        if (actor == null || actor.getId() == null) {
            throw new BusinessException(ErrorCode.NOT_LOGIN_ERROR);
        }
        return actor.getId();
    }

    private void requireText(String value, String message) {
        if (value == null || value.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, message);
        }
    }

    private PlatformApplicationVO toApplicationVO(
        PlatformApplication application,
        boolean archived
    ) {
        PlatformApplicationVO response = new PlatformApplicationVO();
        response.setId(application.getId());
        response.setName(application.getName());
        response.setOwnerId(application.getOwnerId());
        response.setLifecycleStatus(archived ? "ARCHIVED" : "ACTIVE");
        response.setPublicAvailability(archived ? "UNAVAILABLE" : "NOT_PROVISIONED");
        response.setRetained(true);
        response.setRecoverySupported(false);
        if (archived) {
            response.setArchivedBy(application.getArchivedBy());
            response.setArchivedAt(application.getArchivedAt());
        }
        return response;
    }

    private PlatformRequirementVO toRequirementVO(PlatformRequirement requirement) {
        PlatformRequirementVO response = new PlatformRequirementVO();
        response.setId(requirement.getId());
        response.setApplicationId(requirement.getApplicationId());
        response.setOriginalText(requirement.getOriginalText());
        response.setNormalizationStatus(PENDING_NORMALIZATION);
        response.setCreatedAt(requirement.getCreatedAt());
        return response;
    }
}
