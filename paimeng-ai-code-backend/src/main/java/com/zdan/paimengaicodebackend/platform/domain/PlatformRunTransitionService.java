package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformRunTransitionEventMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRun;
import com.zdan.paimengaicodebackend.platform.entity.PlatformRunTransitionEvent;
import com.zdan.paimengaicodebackend.platform.validation.PlatformValidationQueueService;
import java.time.LocalDateTime;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class PlatformRunTransitionService {

    private final PlatformTaskStateMachine stateMachine;
    private final PlatformRunMapper runMapper;
    private final PlatformRunTransitionEventMapper transitionEventMapper;
    private final PlatformLogicalRelationValidator relationValidator;
    private final PlatformRunLeaseService leaseService;
    private final PlatformValidationQueueService validationQueue;

    public PlatformRunTransitionService(
        PlatformTaskStateMachine stateMachine,
        PlatformRunMapper runMapper,
        PlatformRunTransitionEventMapper transitionEventMapper,
        PlatformLogicalRelationValidator relationValidator,
        PlatformRunLeaseService leaseService,
        PlatformValidationQueueService validationQueue
    ) {
        this.stateMachine = stateMachine;
        this.runMapper = runMapper;
        this.transitionEventMapper = transitionEventMapper;
        this.relationValidator = relationValidator;
        this.leaseService = leaseService;
        this.validationQueue = validationQueue;
    }

    @Transactional(rollbackFor = Exception.class)
    public void transition(
        String runId,
        PlatformRunState expectedState,
        PlatformRunState targetState,
        PlatformActor requestedBy,
        String reasonCode,
        String evidenceRef,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        if (runId == null || runId.isBlank() || requestId == null || requestId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 状态转换参数不完整");
        }
        PlatformRun run = runMapper.selectOneByQuery(QueryWrapper.create().eq("id", runId));
        if (run == null || run.getState() == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Run 不存在或状态缺失");
        }
        relationValidator.requireActiveApplication(run.getApplicationId());
        relationValidator.requireTaskBelongsToApplication(run.getApplicationId(), run.getTaskId());
        relationValidator.requireRunBelongsToApplication(run.getApplicationId(), runId);

        PlatformRunState currentState;
        try {
            currentState = PlatformRunState.valueOf(run.getState());
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Run 状态不合法");
        }
        if (currentState != expectedState) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 当前状态已变化");
        }
        stateMachine.assertRunTransition(
            currentState,
            targetState,
            requestedBy,
            leaseService.hasActiveLeaseForRun(runId),
            leaseService.hasNoLeaseForRun(runId)
        );

        PlatformRun update = new PlatformRun();
        update.setState(targetState.name());
        if (runMapper.updateByQuery(
            update,
            true,
            QueryWrapper.create().eq("id", runId).eq("state", expectedState.name())
        ) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Run 当前状态已变化");
        }

        PlatformRunTransitionEvent event = new PlatformRunTransitionEvent();
        event.setApplicationId(run.getApplicationId());
        event.setRunId(runId);
        event.setFromState(expectedState.name());
        event.setToState(targetState.name());
        event.setActorType(requestedBy.name());
        event.setReasonCode(reasonCode);
        event.setEvidenceRef(evidenceRef);
        event.setRequestId(requestId);
        event.setOccurredAt(LocalDateTime.now());
        transitionEventMapper.insert(event);

        // 只有平台推进的 Run 才进入权威验证队列；与 Run 成功共用一个事务
        if (targetState == PlatformRunState.SUCCEEDED && requestedBy == PlatformActor.PLATFORM) {
            validationQueue.enqueue(event.getId(), run.getApplicationId(), runId);
        }

        log.info(
            "Platform Run transition completed, applicationId: {}, runId: {}, from: {}, to: {}, reasonCode: {}, requestId: {}, result: success, durationMs: {}",
            run.getApplicationId(),
            runId,
            expectedState,
            targetState,
            reasonCode,
            requestId,
            java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }
}
