package com.zdan.paimengaicodebackend.platform.domain;

import com.zdan.paimengaicodebackend.constant.UserConstant;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
import com.zdan.paimengaicodebackend.model.entity.User;
import org.springframework.stereotype.Component;

/**
 * Application 的主体鉴权（Issue #80 / T-08）
 * <p>
 * Owner/System Administrator 的判定只保留这一处实现：新增的 Owner 状态读取与阻断答复
 * 端点必须复用它，否则「谁能管理某个 Application」会出现第二套规则。
 */
@Component
public class PlatformApplicationAccessGuard {

    private final AppMapper appMapper;
    private final PlatformLogicalRelationValidator relationValidator;

    public PlatformApplicationAccessGuard(AppMapper appMapper, PlatformLogicalRelationValidator relationValidator) {
        this.appMapper = appMapper;
        this.relationValidator = relationValidator;
    }

    public App requireManaged(Long applicationId, User actor) {
        return requireManaged(applicationId, actor, true);
    }

    /**
     * 校验登录主体对该 Application 的管理权。
     *
     * @param requireActive 是否同时要求 Application 处于 ACTIVE；读取历史状态允许归档后只读
     */
    public App requireManaged(Long applicationId, User actor, boolean requireActive) {
        if (applicationId == null || applicationId <= 0) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Application ID 无效");
        }
        requireActorId(actor);
        App application = relationValidator.requireApplication(applicationId);
        if (actorFor(actor) == PlatformActor.OWNER
            && !requireActorId(actor).equals(application.getUserId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权管理该 Application");
        }
        if (requireActive && !"ACTIVE".equals(application.getLifecycleStatus())) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在或已归档");
        }
        return application;
    }

    /** 归档后的 Application 只保留只读事实；写操作必须先经过 {@link #requireManaged(Long, User)}。 */
    public App requireReadable(Long applicationId, User actor) {
        return requireManaged(applicationId, actor, false);
    }

    public PlatformActor actorFor(User actor) {
        requireActorId(actor);
        return UserConstant.ADMIN_ROLE.equals(actor.getUserRole())
            ? PlatformActor.SYSTEM_ADMINISTRATOR
            : PlatformActor.OWNER;
    }

    public Long requireActorId(User actor) {
        if (actor == null || actor.getId() == null) {
            throw new BusinessException(ErrorCode.NOT_LOGIN_ERROR);
        }
        return actor.getId();
    }

    public boolean isAdmin(User actor) {
        return actorFor(actor) == PlatformActor.SYSTEM_ADMINISTRATOR;
    }

    /** 仅供需要确认 Application 仍可见的读取路径使用，避免直接触碰 Mapper。 */
    public App reload(Long applicationId) {
        return appMapper.selectOneById(applicationId);
    }
}
