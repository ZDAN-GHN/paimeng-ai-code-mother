package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.springframework.stereotype.Service;

@Service
public class PlatformTaskTransitionService {

    private final PlatformTaskStateMachine stateMachine;
    private final PlatformTaskMapper taskMapper;

    public PlatformTaskTransitionService(
        PlatformTaskStateMachine stateMachine,
        PlatformTaskMapper taskMapper
    ) {
        this.stateMachine = stateMachine;
        this.taskMapper = taskMapper;
    }

    public void transition(
        PlatformTask task,
        PlatformTaskState expectedState,
        PlatformTaskState targetState,
        PlatformActor requestedBy,
        TaskTransitionConditions conditions
    ) {
        if (task == null || task.getId() == null || task.getState() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 不存在或状态缺失");
        }
        PlatformTaskState currentState;
        try {
            currentState = PlatformTaskState.valueOf(task.getState());
        } catch (IllegalArgumentException exception) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 状态不合法");
        }
        if (currentState != expectedState) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态已变化");
        }
        stateMachine.assertTaskTransition(currentState, targetState, requestedBy, conditions);

        PlatformTask update = new PlatformTask();
        update.setState(targetState.name());
        QueryWrapper condition = QueryWrapper
            .create()
            .eq("id", task.getId())
            .eq("state", expectedState.name());
        if (taskMapper.updateByQuery(update, true, condition) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态已变化");
        }
        task.setState(targetState.name());
    }
}
