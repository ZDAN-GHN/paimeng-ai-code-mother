package com.zdan.paimengaicodebackend.platform.domain;

import com.mybatisflex.core.query.QueryWrapper;
import com.zdan.paimengaicodebackend.exception.BusinessException;
import com.zdan.paimengaicodebackend.exception.ErrorCode;
import com.zdan.paimengaicodebackend.mapper.platform.PlatformTaskMapper;
import com.zdan.paimengaicodebackend.platform.entity.PlatformTask;
import org.springframework.stereotype.Service;

/**
 * Task 状态转换的意图化外观（Issue #80 / T-08）
 * <p>
 * {@link PlatformTaskTransitionService} 的转换方法刻意是包级私有：调用方只能选择
 * 「要达成什么」，不能自己拼 {@link TaskTransitionConditions}。本类把这个包级能力以
 * 意图命名暴露给 {@code platform.service} 与 {@code platform.validation}，并且在转换
 * 之前先用 CAS 写入与该意图绑定的字段（阻断问题、失败原因），保证
 * 「状态已变但问题没落库」这种不一致不可能出现。
 *
 * <p>所有转换的 actor 恒为 {@link PlatformActor#PLATFORM}：D-06 规定只有 Platform
 * Domain 裁决 Task 状态，Owner 的动作通过本类的意图方法表达，不直接声明身份。
 */
@Service
public class PlatformTaskLifecycleService {

    private static final int MAX_BLOCKING_QUESTION_LENGTH = 500;
    private static final int MAX_FAILURE_CODE_LENGTH = 64;

    /**
     * 唯一阻断问题的唯一校验入口。
     *
     * <p>放在静态方法上是有意的：停 Sandbox、释放 Lease、取消 Run 这些不可逆动作都发生在
     * 问题落库之前，如果各调用方各自校验，问题不合格时已经把一次受控执行拆掉了。
     */
    public static void requireAnswerableQuestion(String question) {
        if (question == null || question.isBlank()) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "阻断问题不能为空");
        }
        if (question.trim().length() > MAX_BLOCKING_QUESTION_LENGTH) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "阻断问题过长");
        }
    }

    private final PlatformTaskTransitionService transitions;
    private final PlatformTaskMapper taskMapper;

    public PlatformTaskLifecycleService(PlatformTaskTransitionService transitions, PlatformTaskMapper taskMapper) {
        this.transitions = transitions;
        this.taskMapper = taskMapper;
    }

    /**
     * {@code CREATED -> READY}：基线已冻结，Task 可被受控 Run 执行。
     *
     * <p>基线冻结由 {@link TaskExecutionBaselineFreezer} 单独完成；状态机的
     * {@code baselineFrozen} 前置条件始终从持久化行实查，调用方不能自称已冻结。
     */
    public void markReady(Long taskId, String reasonCode, String requestId) {
        transitions.transition(taskId, PlatformTaskState.CREATED, PlatformTaskState.READY,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, null, requestId);
    }

    /**
     * {@code CREATED -> BLOCKED}：归一化发现决定性业务歧义，尚未冻结基线。
     *
     * <p>此时既没有 Run 也没有 Sandbox 写入权，正是 D-06 要求的「答复前不启动
     * Sandbox 写入或版本晋升」窗口。
     */
    public void markBlockedForClarification(Long taskId, String question, String reasonCode, String requestId) {
        requireAnswerableQuestion(question);
        writeBlockingQuestion(taskId, question, PlatformTaskState.CREATED, true);
        transitions.transition(taskId, PlatformTaskState.CREATED, PlatformTaskState.BLOCKED,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, null, requestId);
    }

    /**
     * {@code EXECUTING -> BLOCKED}：受控 Run 执行中发现决定性业务歧义。
     *
     * <p>前置条件「Run 已停止且不再持有 Lease」由状态机从
     * {@code platform_run_lease} 与 {@code platform_run} 实查覆盖，调用方无法绕过。
     */
    public void markBlockedAfterRunStopped(Long taskId, String question, String reasonCode, String requestId) {
        requireAnswerableQuestion(question);
        writeBlockingQuestion(taskId, question, PlatformTaskState.EXECUTING, false);
        transitions.transition(taskId, PlatformTaskState.EXECUTING, PlatformTaskState.BLOCKED,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, null, requestId);
    }

    /**
     * {@code BLOCKED -> CREATED}：Owner 答复后重新归一化。
     *
     * <p>只允许尚未冻结基线的 Task 走这条边；已有基线的阻断按 D-06 必须新建 Task，
     * 由 {@link PlatformRequirementNormalizationService} 负责。
     */
    public void reopenForReNormalization(Long taskId, String reasonCode, String requestId) {
        transitions.transition(taskId, PlatformTaskState.BLOCKED, PlatformTaskState.CREATED,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, null, requestId);
    }

    /**
     * {@code READY -> EXECUTING}：Platform 已创建 Run 并授予 fenced Lease。
     *
     * @param evidenceRef 本次执行所依据的冻结基线指纹；状态机要求执行类转换必须可追溯到
     *                    一个已持久化的输入，否则事后无法解释「这次写的是哪份基线」
     */
    public void markExecutionStarted(Long taskId, String evidenceRef, String reasonCode, String requestId) {
        transitions.transition(taskId, PlatformTaskState.READY, PlatformTaskState.EXECUTING,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, evidenceRef, requestId);
    }

    /**
     * {@code EXECUTING -> FAILED}：权威验证未通过或执行不可恢复地失败。
     *
     * @param expectedState 允许的来源状态，缺省 {@code EXECUTING}
     */
    public void markFailed(Long taskId, String failureCode, String reasonCode, String evidenceRef, String requestId) {
        markFailed(taskId, PlatformTaskState.EXECUTING, failureCode, reasonCode, evidenceRef, requestId);
    }

    public void markFailed(
        Long taskId,
        PlatformTaskState expectedState,
        String failureCode,
        String reasonCode,
        String evidenceRef,
        String requestId
    ) {
        if (expectedState == null) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "Task 期望状态缺失");
        }
        writeFailureCode(taskId, expectedState, failureCode);
        transitions.transition(taskId, expectedState, PlatformTaskState.FAILED,
            PlatformActor.PLATFORM, TaskTransitionConditions.none(), reasonCode, evidenceRef, requestId);
    }

    private void writeBlockingQuestion(Long taskId, String question, PlatformTaskState expectedState, boolean requireNoBaseline) {
        PlatformTask update = new PlatformTask();
        update.setBlockedQuestion(question.trim());
        QueryWrapper condition = QueryWrapper.create()
            .eq("id", taskId)
            .eq("state", expectedState.name());
        if (requireNoBaseline) {
            condition.isNull("baselineJson");
        } else {
            condition.isNotNull("baselineJson");
        }
        if (taskMapper.updateByQuery(update, true, condition) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态无法记录阻断问题");
        }
    }

    private void writeFailureCode(Long taskId, PlatformTaskState expectedState, String failureCode) {
        if (failureCode == null || failureCode.isBlank()
            || failureCode.length() > MAX_FAILURE_CODE_LENGTH
            || !failureCode.matches("[A-Z][A-Z0-9_]{0,63}")) {
            throw new BusinessException(ErrorCode.PARAMS_ERROR, "失败原因码不合法");
        }
        PlatformTask update = new PlatformTask();
        update.setFailureCode(failureCode);
        if (taskMapper.updateByQuery(update, true,
            QueryWrapper.create().eq("id", taskId).eq("state", expectedState.name())) != 1) {
            throw new BusinessException(ErrorCode.FORBIDDEN_ERROR, "Task 当前状态无法记录失败原因");
        }
    }

}
