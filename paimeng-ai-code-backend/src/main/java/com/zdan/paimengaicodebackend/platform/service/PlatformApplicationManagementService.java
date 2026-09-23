package com.zdan.paimengaicodebackend.platform.service;

import com.mybatisflex.core.query.QueryWrapper;
import com.mybatisflex.core.paginate.Page;
import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.ai.enums.CodeGenTypeEnum;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRequirementMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import com.zdan.paimengaicodebackend.platform.domain.PlatformActor;
import com.zdan.paimengaicodebackend.platform.domain.PlatformApplicationArchiveService;
import com.zdan.paimengaicodebackend.platform.domain.PlatformLogicalRelationValidator;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRequirement;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformApplicationInitialRequirementVO;
import com.zdan.paimengaicodebackend.platform.vo.PlatformRequirementVO;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PlatformApplicationManagementService {

    private static final String PENDING_NORMALIZATION = "PENDING_NORMALIZATION";

    private final AppMapper appMapper;
    private final PlatformRequirementMapper requirementMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformApplicationArchiveService archiveService;

    public PlatformApplicationManagementService(
        AppMapper appMapper,
        PlatformRequirementMapper requirementMapper,
        PlatformLogicalRelationValidator relationValidator,
        PlatformApplicationArchiveService archiveService
    ) {
        this.appMapper = appMapper;
        this.requirementMapper = requirementMapper;
        this.relationValidator = relationValidator;
        this.archiveService = archiveService;
    }

    @Transactional(rollbackFor = Exception.class)
    public PlatformApplicationVO createApplication(User actor, String name) {
        requireText(name, "Application 名称不能为空");
        Long actorId = requireActorId(actor);

        App application = new App();
        application.setUserId(actorId);
        application.setAppName(name.trim());
        application.setCodeGenType(CodeGenTypeEnum.HTML.getValue());
        application.setIsDelete(0);
        application.setLifecycleStatus("ACTIVE");
        appMapper.insertSelective(application);
        return toApplicationVO(application, false);
    }

    @Transactional(rollbackFor = Exception.class)
    public PlatformApplicationInitialRequirementVO createApplicationWithInitialRequirement(
        User actor,
        String name,
        String originalText
    ) {
        PlatformApplicationVO application = createApplication(actor, name);
        PlatformRequirementVO requirement = submitRequirement(Long.valueOf(application.getId()), actor, originalText);
        PlatformApplicationInitialRequirementVO response = new PlatformApplicationInitialRequirementVO();
        response.setApplication(application);
        response.setRequirement(requirement);
        return response;
    }

    public Page<PlatformApplicationVO> listMyApplications(User actor, long pageNum, long pageSize) {
        Long actorId = requireActorId(actor);
        Page<App> applications = appMapper.paginate(
            Page.of(pageNum, pageSize),
                QueryWrapper.create()
                    .eq("userId", actorId)
                    .eq("isDelete", 0)
                    .orderBy(App::getCreateTime, false)
        );
        Page<PlatformApplicationVO> response = new Page<>(pageNum, pageSize, applications.getTotalRow());
        response.setRecords(
            applications.getRecords().stream().map(application -> toApplicationVO(application, false)).toList()
        );
        return response;
    }

    public PlatformApplicationVO getApplication(Long applicationId, User actor) {
        return toApplicationVO(requireAuthorizedApplication(applicationId, actor), false);
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
        requireAuthorizedApplication(applicationId, actor);
        PlatformRequirement requirement = requirementMapper.selectOneByQuery(
            QueryWrapper.create().eq("id", requirementId).eq("appId", applicationId)
        );
        if (requirement == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Requirement 不存在");
        }
        return toRequirementVO(requirement);
    }

    public Page<PlatformRequirementVO> listRequirements(
        Long applicationId,
        User actor,
        long pageNum,
        long pageSize
    ) {
        requireAuthorizedApplication(applicationId, actor);
        Page<PlatformRequirement> requirements = requirementMapper.paginate(
            Page.of(pageNum, pageSize),
            QueryWrapper.create()
                .eq("appId", applicationId)
                .orderBy(PlatformRequirement::getCreatedAt, false)
        );
        Page<PlatformRequirementVO> response = new Page<>(pageNum, pageSize, requirements.getTotalRow());
        response.setRecords(requirements.getRecords().stream().map(this::toRequirementVO).toList());
        return response;
    }

    public PlatformApplicationVO archiveApplication(Long applicationId, User actor) {
        App application = requireAuthorizedActiveApplication(applicationId, actor);
        Long actorId = requireActorId(actor);
        App archivedApplication = archiveService.archive(
            applicationId,
            actorId,
            actorFor(actor),
            "ARCHIVE_REQUEST",
            UUID.randomUUID().toString()
        );
        return toApplicationVO(archivedApplication, true);
    }

    private App requireAuthorizedActiveApplication(Long applicationId, User actor) {
        App application = requireAuthorizedApplication(applicationId, actor);
        if (!"ACTIVE".equals(application.getLifecycleStatus())) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在或已归档");
        }
        return application;
    }

    private App requireAuthorizedApplication(Long applicationId, User actor) {
        if (applicationId == null || applicationId <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application ID 无效");
        }
        App application = relationValidator.requireApplication(applicationId);
        if (
            actorFor(actor) == PlatformActor.OWNER &&
            !requireActorId(actor).equals(application.getUserId())
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
        App application,
        boolean archived
    ) {
        PlatformApplicationVO response = new PlatformApplicationVO();
        response.setId(identifierText(application.getId()));
        response.setName(application.getAppName());
        response.setOwnerId(identifierText(application.getUserId()));
        response.setLifecycleStatus(application.getLifecycleStatus());
        boolean isArchived = archived || "ARCHIVED".equals(application.getLifecycleStatus());
        response.setPublicAvailability(isArchived ? "UNAVAILABLE" : "NOT_PROVISIONED");
        response.setRetained(true);
        response.setRecoverySupported(false);
        if (isArchived) {
            response.setArchivedBy(identifierText(application.getArchivedBy()));
            response.setArchivedAt(application.getArchivedTime());
        }
        return response;
    }

    private PlatformRequirementVO toRequirementVO(PlatformRequirement requirement) {
        PlatformRequirementVO response = new PlatformRequirementVO();
        response.setId(identifierText(requirement.getId()));
        response.setApplicationId(identifierText(requirement.getApplicationId()));
        response.setOriginalText(requirement.getOriginalText());
        response.setNormalizationStatus(PENDING_NORMALIZATION);
        response.setCreatedAt(requirement.getCreatedAt());
        return response;
    }

    private String identifierText(Long identifier) {
        return identifier == null ? null : String.valueOf(identifier);
    }
}
