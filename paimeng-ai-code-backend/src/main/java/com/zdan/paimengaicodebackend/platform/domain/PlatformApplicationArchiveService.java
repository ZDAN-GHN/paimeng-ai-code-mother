package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformApplicationLifecycleEventMapper;
import com.zdan.paimengaicodebackend.mapper.AppMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.model.entity.App;
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

    private final AppMapper appMapper;
    private final PlatformRunMapper runMapper;
    private final PlatformApplicationLifecycleEventMapper lifecycleEventMapper;
    private final PlatformLogicalRelationValidator relationValidator;

    public PlatformApplicationArchiveService(
        AppMapper appMapper,
        PlatformRunMapper runMapper,
        PlatformApplicationLifecycleEventMapper lifecycleEventMapper,
        PlatformLogicalRelationValidator relationValidator
    ) {
        this.appMapper = appMapper;
        this.runMapper = runMapper;
        this.lifecycleEventMapper = lifecycleEventMapper;
        this.relationValidator = relationValidator;
    }

    @Transactional(rollbackFor = Exception.class)
    public App archive(
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
            QueryWrapper.create().eq("appId", applicationId).eq("requestId", requestId)
        ) == 1) {
            App archivedApplication = appMapper.selectOneByQuery(
                QueryWrapper.create().eq("id", applicationId)
            );
            if (archivedApplication == null) {
                throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Application 不存在");
            }
            return archivedApplication;
        }

        App application = relationValidator.requireActiveApplication(applicationId);
        if (actor == PlatformActor.OWNER && !actorId.equals(application.getUserId())) {
            throw new BusinessException(ErrorCode.NO_AUTH_ERROR, "Owner 不属于 Application");
        }
        if (runMapper.selectCountByQuery(
            QueryWrapper.create()
                .eq("appId", applicationId)
                .in("state", ACTIVE_WRITING_RUN_STATES)
        ) > 0) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "存在活跃写入型 Run，不能归档 Application");
        }

        App update = new App();
        update.setLifecycleStatus("ARCHIVED");
        update.setArchivedTime(LocalDateTime.now());
        update.setArchivedBy(actorId);
        update.setArchiveReason(reasonCode);
        if (appMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create()
                .eq("id", applicationId)
                .eq("isDelete", 0)
                .eq("lifecycleStatus", "ACTIVE")
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
        application.setLifecycleStatus("ARCHIVED");
        application.setArchivedTime(update.getArchivedTime());
        application.setArchivedBy(actorId);
        application.setArchiveReason(reasonCode);
        return application;
    }
}
