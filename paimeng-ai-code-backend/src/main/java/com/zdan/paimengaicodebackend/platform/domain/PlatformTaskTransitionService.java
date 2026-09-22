package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskTransitionEventMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTaskTransitionEvent;
import java.time.LocalDateTime;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class PlatformTaskTransitionService {

    private final PlatformTaskStateMachine stateMachine;
    private final PlatformTaskMapper taskMapper;
    private final PlatformTaskTransitionEventMapper transitionEventMapper;
    private final PlatformLogicalRelationValidator relationValidator;

    public PlatformTaskTransitionService(
        PlatformTaskStateMachine stateMachine,
        PlatformTaskMapper taskMapper,
        PlatformTaskTransitionEventMapper transitionEventMapper,
        PlatformLogicalRelationValidator relationValidator
    ) {
        this.stateMachine = stateMachine;
        this.taskMapper = taskMapper;
        this.transitionEventMapper = transitionEventMapper;
        this.relationValidator = relationValidator;
    }

    @Transactional(rollbackFor = Exception.class)
    void transition(
        Long taskId,
        PlatformTaskState expectedState,
        PlatformTaskState targetState,
        PlatformActor requestedBy,
        TaskTransitionConditions requestedConditions,
        String reasonCode,
        String evidenceRef,
        String requestId
    ) {
        long startedNanos = System.nanoTime();
        if (taskId == null || expectedState == null || targetState == null || requestId == null || requestId.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 状态转换参数不完整");
        }
        if (requestedConditions == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 状态转换前置条件缺失");
        }
        PlatformTask task = taskMapper.selectOneByQuery(QueryWrapper.create().eq("id", taskId));
        if (task == null || task.getState() == null) {
            throw new BusinessException(ErrorCode.NOT_FOUND_ERROR, "Task 不存在或状态缺失");
        }
        relationValidator.requireActiveApplication(task.getApplicationId());
        relationValidator.requireTaskBelongsToApplication(task.getApplicationId(), taskId);

        PlatformTaskState currentState;
        try {
            currentState = PlatformTaskState.valueOf(task.getState());
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 状态不合法");
        }
        if (currentState != expectedState) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态已变化");
        }
        if (
            (targetState == PlatformTaskState.EXECUTING || targetState == PlatformTaskState.VALIDATED) &&
            (evidenceRef == null || evidenceRef.isBlank())
        ) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "状态转换缺少受控证据引用");
        }
        TaskTransitionConditions persistedConditions = requestedConditions.withPersistedBaseline(
            task.getBaselineJson() != null
        );
        stateMachine.assertTaskTransition(currentState, targetState, requestedBy, persistedConditions);

        PlatformTask update = new PlatformTask();
        update.setState(targetState.name());
        QueryWrapper condition = QueryWrapper
            .create()
            .eq("id", taskId)
            .eq("state", expectedState.name());
        if (taskMapper.updateByQuery(update, true, condition) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态已变化");
        }

        PlatformTaskTransitionEvent event = new PlatformTaskTransitionEvent();
        event.setApplicationId(task.getApplicationId());
        event.setTaskId(taskId);
        event.setFromState(expectedState.name());
        event.setToState(targetState.name());
        event.setActorType(requestedBy.name());
        event.setReasonCode(reasonCode);
        event.setEvidenceRef(evidenceRef);
        event.setRequestId(requestId);
        event.setOccurredAt(LocalDateTime.now());
        transitionEventMapper.insert(event);
        log.info(
            "Platform Task transition completed, applicationId: {}, taskId: {}, from: {}, to: {}, reasonCode: {}, requestId: {}, result: success, durationMs: {}",
            task.getApplicationId(),
            taskId,
            expectedState,
            targetState,
            reasonCode,
            requestId,
            java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos)
        );
    }
}
