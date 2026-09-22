package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.springframework.stereotype.Service;

@Service
public class TaskExecutionBaselineFreezer {

    private final TaskExecutionBaselineCodec codec;
    private final PlatformTaskMapper taskMapper;
    private final PlatformLogicalRelationValidator relationValidator;

    public TaskExecutionBaselineFreezer(
        TaskExecutionBaselineCodec codec,
        PlatformTaskMapper taskMapper,
        PlatformLogicalRelationValidator relationValidator
    ) {
        this.codec = codec;
        this.taskMapper = taskMapper;
        this.relationValidator = relationValidator;
    }

    public void freeze(PlatformTask task, TaskExecutionBaseline baseline) {
        if (task == null || task.getId() == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 不存在");
        }
        if (task.getBaselineJson() != null) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "TaskExecutionBaseline 已冻结");
        }
        relationValidator.requireActiveApplication(task.getApplicationId());
        relationValidator.requireTaskBelongsToApplication(task.getApplicationId(), task.getId());
        relationValidator.requireRequirementBelongsToApplication(task.getApplicationId(), task.getRequirementId());

        String serializedBaseline = codec.serialize(baseline);
        PlatformTask update = new PlatformTask();
        update.setBaselineSchemaVersion(baseline.schemaVersion());
        update.setBaseProfileVersion(baseline.baseProfileVersion());
        update.setBaseSourceRevision(baseline.baseSourceRevision());
        update.setRequestedOutcome(baseline.requestedOutcome());
        update.setAcceptanceTarget(baseline.acceptanceTarget());
        update.setBaselineJson(serializedBaseline);

        QueryWrapper condition = QueryWrapper
            .create()
            .eq("id", task.getId())
            .isNull("baseline_json");
        if (taskMapper.updateByQuery(update, true, condition) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "TaskExecutionBaseline 已冻结或 Task 不存在");
        }

        task.setBaselineSchemaVersion(baseline.schemaVersion());
        task.setBaseProfileVersion(baseline.baseProfileVersion());
        task.setBaseSourceRevision(baseline.baseSourceRevision());
        task.setRequestedOutcome(baseline.requestedOutcome());
        task.setAcceptanceTarget(baseline.acceptanceTarget());
        task.setBaselineJson(serializedBaseline);
    }
}
