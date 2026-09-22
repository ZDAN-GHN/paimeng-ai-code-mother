package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationLifecycleEventMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplication;
import com.zdan.paimengaicodebackend.platform.entity.PlatformApplicationLifecycleEvent;
import java.time.LocalDateTime;
import java.util.List;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class PlatformApplicationArchiveService {

    private static final List<String> ACTIVE_WRITING_RUN_STATES = List.of("LEASED", "EXECUTING");

    private final PlatformApplicationMapper applicationMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformApplicationLifecycleEventMapper lifecycleEventMapper;
    private final PlatformLogicalRelationValidator relationValidator;

    public PlatformApplicationArchiveService(
        PlatformApplicationMapper applicationMapper,
        PlatformRunMapper runMapper,
        PlatformApplicationLifecycleEventMapper lifecycleEventMapper,
        PlatformLogicalRelationValidator relationValidator
    ) {
        this.applicationMapper = applicationMapper;
        this.runMapper = runMapper;
        this.lifecycleEventMapper = lifecycleEventMapper;
        this.relationValidator = relationValidator;
    }

    @Transactional(rollbackFor = Exception.class)
    public PlatformApplication archive(
        Long applicationId,
        Long actorId,
        PlatformActor actor,
        String reasonCode,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        if (applicationId == null || actorId == null || requestId == null || requestId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "归档参数不完整");
        }
        if (actor != PlatformActor.OWNER && actor != PlatformActor.SYSTEM_ADMINISTRATOR) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "无权归档 Application");
        }
        if (lifecycleEventMapper.selectCountByQuery(
            QueryWrapper.create().eq("application_id", applicationId).eq("request_id", requestId)
        ) == 1) {
            PlatformApplication archivedApplication = new PlatformApplication();
            archivedApplication.setId(applicationId);
            archivedApplication.setIsDeleted(1);
            return archivedApplication;
        }

        PlatformApplication application = relationValidator.requireActiveApplication(applicationId);
        if (actor == PlatformActor.OWNER && !actorId.equals(application.getOwnerId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "Owner 不属于 Application");
        }
        if (runMapper.selectCountByQuery(
            QueryWrapper.create()
                .eq("application_id", applicationId)
                .in("state", ACTIVE_WRITING_RUN_STATES)
        ) > 0) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "存在活跃写入型 Run，不能归档 Application");
        }

        PlatformApplication update = new PlatformApplication();
        update.setIsDeleted(1);
        update.setArchivedAt(LocalDateTime.now());
        update.setArchivedBy(actorId);
        update.setArchiveReason(reasonCode);
        if (applicationMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("id", applicationId).eq("is_deleted", 0)
        ) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Application 已归档或状态已变化");
        }

        PlatformApplicationLifecycleEvent event = new PlatformApplicationLifecycleEvent();
        event.setApplicationId(applicationId);
        event.setEventType("ARCHIVED");
        event.setActorType(actor.name());
        event.setActorId(actorId);
        event.setReasonCode(reasonCode);
        event.setRequestId(requestId);
        event.setOccurredAt(LocalDateTime.now());
        lifecycleEventMapper.insert(event);
        log.info(
            "Platform Application archive completed, applicationId: {}, actorId: {}, reasonCode: {}, requestId: {}, result: success, durationMs: {}",
            applicationId,
            actorId,
            reasonCode,
            requestId,
            java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
        application.setIsDeleted(1);
        application.setArchivedAt(update.getArchivedAt());
        application.setArchivedBy(actorId);
        application.setArchiveReason(reasonCode);
        return application;
    }
}
